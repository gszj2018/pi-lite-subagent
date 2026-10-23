/** Branch-authoritative subagent history plus a transient, session-local execution observation cache. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type DisplayItem, getDisplayItems } from "./subagent-rendering.ts";
import type { UsageStats } from "./types.ts";

export type HistoryStatus = "Completed" | "Failed" | "Aborted" | "Pending / running" | "Not started" |
  "Skipped" | "Not executed" | "Unknown / interrupted" | "Result details unavailable";

export interface HistoryResult {
  agent: string;
  task: string;
  exitCode?: number;
  step?: number;
  items: DisplayItem[];
  usage: UsageStats;
  stderr: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface HistoryTask {
  id: string;
  toolCallId: string;
  index: number;
  mode: "parallel" | "chain";
  agent: string;
  task: string;
  status: HistoryStatus;
  result?: HistoryResult;
  callOutput: string;
}

interface CallSnapshot {
  active: boolean;
  finished: boolean;
  fromMessage?: boolean;
  isError: boolean;
  output: string;
  details?: { mode: "parallel" | "chain"; results: (HistoryResult | undefined)[] };
}

interface HistoryCall {
  id: string;
  mode: "parallel" | "chain";
  tasks: { agent: string; task: string }[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function decodeResult(value: unknown): HistoryResult | undefined {
  const r = record(value);
  if (!r || typeof r.agent !== "string" || typeof r.task !== "string" || !Array.isArray(r.messages)) return;
  if (r.exitCode !== undefined && (typeof r.exitCode !== "number" || !Number.isInteger(r.exitCode))) return;
  if (r.step !== undefined && (typeof r.step !== "number" || !Number.isInteger(r.step) || r.step < 1)) return;
  const rawUsage = record(r.usage);
  const count = (key: string) => {
    const value = rawUsage?.[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    agent: r.agent,
    task: r.task,
    exitCode: r.exitCode as number | undefined,
    step: typeof r.step === "number" && Number.isInteger(r.step) && r.step >= 1 ? r.step : undefined,
    items: getDisplayItems(r.messages),
    usage: {
      input: count("input"), output: count("output"), cacheRead: count("cacheRead"), cacheWrite: count("cacheWrite"),
      cost: count("cost"), contextTokens: count("contextTokens"), turns: count("turns"),
    },
    stderr: optionalString(r.stderr) ?? "",
    model: optionalString(r.model),
    stopReason: optionalString(r.stopReason),
    errorMessage: optionalString(r.errorMessage),
  };
}

function decodeSnapshot(value: unknown, active: boolean, finished: boolean): CallSnapshot {
  const payload = record(value);
  const details = record(payload?.details);
  const content = payload?.content;
  const output = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap((part) => {
      const p = record(part);
      return p?.type === "text" && typeof p.text === "string" ? [p.text] : [];
    }).join("\n") : "";
  return {
    active, finished, output, isError: payload?.isError === true,
    details: details && (details.mode === "parallel" || details.mode === "chain") && Array.isArray(details.results)
      ? { mode: details.mode, results: details.results.map(decodeResult) } : undefined,
  };
}

function readBranch(branch: readonly unknown[], withResults = true): { calls: HistoryCall[]; results: Map<string, CallSnapshot> } {
  const calls: HistoryCall[] = [];
  const results = new Map<string, CallSnapshot>();
  for (const entry of branch) {
    const e = record(entry);
    const msg = e?.type === "message" ? record(e.message) : undefined;
    if (!msg) continue;
    if (withResults && msg.role === "toolResult" && msg.toolName === "subagent" && typeof msg.toolCallId === "string") {
      results.set(msg.toolCallId, decodeSnapshot(msg, false, true));
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        const call = record(part);
        if (call?.type !== "toolCall" || call.name !== "subagent" || typeof call.id !== "string" || !call.id) continue;
        const args = record(call.arguments);
        const rawTasks = args?.tasks;
        const tasks = Array.isArray(rawTasks) && rawTasks.length ? rawTasks : [undefined];
        calls.push({
          id: call.id,
          mode: args?.mode === "chain" ? "chain" : "parallel",
          tasks: tasks.map((value) => {
            const task = record(value);
            return {
              agent: optionalString(task?.agent) ?? "unknown",
              task: optionalString(task?.task) ?? "(invalid task)",
            };
          }),
        });
      }
    }
  }
  return { calls, results };
}

function failed(result: HistoryResult): boolean {
  return (result.exitCode !== undefined && result.exitCode !== 0) || result.stopReason === "error" ||
    result.stopReason === "aborted" || !!result.errorMessage;
}

function taskStatus(result: HistoryResult | undefined, call: CallSnapshot | undefined, skipped: boolean): HistoryStatus {
  if (result) {
    if (result.stopReason === "aborted") return "Aborted";
    if (failed(result)) return "Failed";
    if (result.exitCode !== undefined) return "Completed";
    return call?.active ? "Pending / running" : "Unknown / interrupted";
  }
  if (skipped) return "Skipped";
  if (call?.finished && call.isError && call.details?.results.length === 0) return "Not executed";
  if (call?.finished) return "Result details unavailable";
  return call?.active ? "Not started" : "Unknown / interrupted";
}

function buildTasks(calls: HistoryCall[], results: ReadonlyMap<string, CallSnapshot>, live: ReadonlyMap<string, CallSnapshot>): HistoryTask[] {
  return calls.reverse().flatMap((call) => {
    // Persisted results, including redacted/missing details, always override the observation cache.
    const observed = results.get(call.id) ?? live.get(call.id);
    const snapshot = observed?.details && observed.details.mode !== call.mode ? { ...observed, details: undefined } : observed;
    const decoded = snapshot?.details?.results ?? [];
    const aligned = call.tasks.map((task, index) => {
      const result = call.mode === "chain"
        ? decoded.find((result) => result?.step === index + 1) ?? (decoded[index]?.step === undefined ? decoded[index] : undefined)
        : decoded[index];
      return result?.agent === task.agent ? result : undefined;
    });
    return call.tasks.map((task, index) => {
      const result = aligned[index];
      const skipped = call.mode === "chain" && !!snapshot?.finished && aligned.some((r, i) => i < index && r && failed(r));
      let status = taskStatus(result, snapshot, skipped);
      if (!result && snapshot?.active && call.mode === "parallel") status = "Pending / running";
      return {
        id: `${call.id}:${index}`, toolCallId: call.id, index, mode: call.mode, ...task,
        status, result, callOutput: snapshot?.output ?? "",
      };
    }).reverse();
  });
}

export interface SubagentHistory {
  read(ctx: ExtensionContext): HistoryTask[];
  subscribe(listener: () => void): () => void;
}

export function registerSubagentHistory(pi: ExtensionAPI): SubagentHistory {
  let sessionId: string | undefined;
  let acceptingEvents = true;
  const live = new Map<string, CallSnapshot>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const belongsToSession = (ctx: ExtensionContext) => {
    if (!acceptingEvents) return false;
    sessionId ??= ctx.sessionManager.getSessionId();
    return sessionId === ctx.sessionManager.getSessionId();
  };
  const branch = (ctx: ExtensionContext, withResults = true) => readBranch(ctx.sessionManager.getBranch(), withResults);
  const read = (ctx: ExtensionContext): HistoryTask[] => {
    const { calls, results } = branch(ctx);
    if (!belongsToSession(ctx)) return buildTasks(calls, results, new Map());
    const ids = new Set(calls.map((call) => call.id));
    for (const id of live.keys()) if (!ids.has(id) || results.has(id)) live.delete(id);
    return buildTasks(calls, results, live);
  };
  const observe = (id: string, ctx: ExtensionContext, snapshot: CallSnapshot) => {
    if (!belongsToSession(ctx) || !branch(ctx, false).calls.some((call) => call.id === id)) return;
    live.set(id, snapshot);
    notify();
  };

  pi.on("session_start", (_event, ctx) => {
    acceptingEvents = true;
    sessionId = ctx.sessionManager.getSessionId();
    live.clear();
  });
  pi.on("session_shutdown", () => {
    acceptingEvents = false;
    sessionId = undefined;
    live.clear();
    listeners.clear();
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "subagent" || event.parentToolCallId !== undefined) return;
    observe(event.toolCallId, ctx, decodeSnapshot(undefined, true, false));
  });
  pi.on("tool_execution_update", (event, ctx) => {
    if (event.toolName !== "subagent" || event.parentToolCallId !== undefined) return;
    if (live.get(event.toolCallId)?.finished) return;
    observe(event.toolCallId, ctx, decodeSnapshot(event.partialResult, true, false));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "subagent" || event.parentToolCallId !== undefined) return;
    if (live.get(event.toolCallId)?.fromMessage) return;
    const snapshot = decodeSnapshot(event.result, false, true);
    snapshot.isError = event.isError;
    observe(event.toolCallId, ctx, snapshot);
  });
  pi.on("message_end", (event, ctx) => {
    const msg = record(event.message);
    if (msg?.role !== "toolResult" || msg.toolName !== "subagent" || typeof msg.toolCallId !== "string") return;
    // This hook runs before persistence. Keep the final message until a later read sees it in getBranch().
    observe(msg.toolCallId, ctx, { ...decodeSnapshot(msg, false, true), fromMessage: true });
  });
  const reconcile = (ctx: ExtensionContext) => {
    if (live.size === 0 && listeners.size === 0) return;
    read(ctx);
    notify();
  };
  pi.on("session_tree", (_event, ctx) => { reconcile(ctx); });
  pi.on("turn_end", (_event, ctx) => { reconcile(ctx); });
  pi.on("agent_settled", (_event, ctx) => {
    if (!belongsToSession(ctx)) return;
    for (const snapshot of live.values()) snapshot.active = false;
    reconcile(ctx);
  });

  return {
    read,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
