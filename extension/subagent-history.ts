/** Branch-authoritative history, transient execution observations and the view-subagents browser command. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { getDisplayItems, getTextContent, parseSubagentDetails } from "./result-parsing.ts";
import type { BrowserContent, BrowserController } from "./subagent-browser.ts";
import { appendDisplayItems, formatUsageStats } from "./subagent-rendering.ts";
import type { DisplayItem, SingleResult } from "./types.ts";

type HistoryStatus = "Completed" | "Failed" | "Aborted" | "Pending / running" | "Not started" |
  "Skipped" | "Not executed" | "Unknown / interrupted" | "Result details unavailable";

type HistoryResult = Omit<SingleResult, "messages" | "agentSource"> & { items: DisplayItem[] };

interface HistoryTask {
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
  details?: { mode: "parallel" | "chain"; results: HistoryResult[] };
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

function toHistoryResult(result: SingleResult): HistoryResult {
  const { agent, task, exitCode, step, stderr, model, stopReason, errorMessage } = result;
  return {
    agent, task, exitCode, step, stderr, model, stopReason, errorMessage,
    items: getDisplayItems(result.messages),
    usage: { ...result.usage },
  };
}

function decodeSnapshot(value: unknown, active: boolean, finished: boolean): CallSnapshot {
  const payload = record(value);
  const details = parseSubagentDetails(payload?.details);
  return {
    active, finished, output: getTextContent(payload?.content), isError: payload?.isError === true,
    details: details ? { mode: details.mode, results: details.results.map(toHistoryResult) } : undefined,
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
        ? decoded.find((result) => result.step === index + 1) ?? (decoded[index]?.step === undefined ? decoded[index] : undefined)
        : decoded[index];
      return result?.agent === task.agent ? result : undefined;
    });
    return call.tasks.map((task, index) => {
      const result = aligned[index];
      const skipped = call.mode === "chain" && !!snapshot?.finished && aligned.some((r, i) => i < index && r && failed(r));
      let status = taskStatus(result, snapshot, skipped);
      // Missing parallel results do not prove a task is unstarted; it may be running before its first update.
      if (!result && snapshot?.active && call.mode === "parallel") status = "Pending / running";
      return {
        id: `${call.id}:${index}`, toolCallId: call.id, index, mode: call.mode, ...task,
        status, result, callOutput: snapshot?.output ?? "",
      };
    }).reverse();
  });
}

function historyDetail(task: HistoryTask, theme: Theme): Container {
  const container = new Container();
  const field = (name: string, value: string) => {
    container.addChild(new Text(theme.fg("muted", `${name}: `) + stripTerminalSequences(value), 0, 0));
  };
  field("Status", task.status);
  field("Mode", task.mode === "chain" ? `chain · Step ${task.index + 1}` : "parallel");
  field("Task", task.task);
  const result = task.result;
  if (result) {
    if (result.task !== task.task) field("Executed task", result.task);
    if (result.model) field("Model", result.model);
    appendDisplayItems(container, result.items, theme);
    if (result.errorMessage) field("Error", result.errorMessage);
    const failed = task.status === "Failed" || task.status === "Aborted";
    if (result.stderr && (failed || result.items.length === 0)) field("Stderr", result.stderr);
    if (result.items.length === 0 && !result.errorMessage && !result.stderr) {
      container.addChild(new Text("(no output)", 0, 0));
    }
    const usage = formatUsageStats(result.usage);
    if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  } else {
    container.addChild(new Spacer(1));
    container.addChild(new Text(stripTerminalSequences(task.callOutput) || "(no output available)", 0, 0));
  }
  return container;
}

function historyContent(tasks: HistoryTask[]): BrowserContent {
  return {
    title: "Subagent executions [active branch]",
    emptyMessage: "No subagent calls found on the active branch.",
    items: tasks.map((task) => {
      const status = task.status === "Completed" ? "" : ` (${task.status})`;
      return {
        id: task.id,
        label: `${task.agent}${status}`,
        description: task.mode === "chain" ? task.task.replace(/\{previous\}/g, "").trim() : task.task,
        createDetail: (theme) => historyDetail(task, theme),
      };
    }),
  };
}

export function registerSubagentHistory(pi: ExtensionAPI, browserController: BrowserController): void {
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

  browserController.registerBrowser("view-subagents", "Browse subagent execution status and results on the active branch.",
    (ctx) => historyContent(read(ctx)),
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
}
