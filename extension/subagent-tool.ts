/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent task, giving it an isolated
 * context window. The tool takes a fixed parameter shape: `mode` plus a `tasks`
 * list of {agent, task} entries.
 *
 * Modes:
 *   - parallel (default): run all tasks concurrently (bounded concurrency)
 *   - chain: run tasks sequentially; later tasks can reference the previous
 *     output via the {previous} placeholder
 *
 * A single task behaves the same in either mode. Uses JSON mode to capture
 * structured output from subagents.
 */

import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents } from "./agents.ts";
import { emptyUsageStats, getFinalOutput, getResultOutput, isFailedResult, runSingleAgent } from "./run-agent.ts";
import { truncateSubagentOutput } from "./truncation.ts";
import type { DispatchDefaults, OnUpdateCallback, SingleResult, SubagentDetails, SubagentRunnerDeps } from "./types.ts";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;

type ExecutionMode = "parallel" | "chain";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function parseLineNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatReadLineRange(offset: unknown, limit: unknown): string | undefined {
  // Strict schemas represent omitted optional arguments as null.
  if (offset == null && limit == null) return undefined;
  const start = offset == null ? 1 : parseLineNumber(offset);
  if (start === undefined) return undefined;
  if (limit == null) return `:${start}`;
  const count = parseLineNumber(limit);
  if (count === undefined) return undefined;
  const end = start + count - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const lineRange = formatReadLineRange(args.offset, args.limit);
      let text = themeFg("accent", filePath);
      if (lineRange) {
        text += themeFg("warning", lineRange);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: SingleResult["messages"]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({
    description: "Task to delegate to the agent. Chain mode supports the {previous} placeholder for the previous step's output.",
  }),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const ModeSchema = StringEnum(["parallel", "chain"] as const, {
  description: 'Execution mode for the task list. Default: "parallel". A single task behaves the same in both modes.',
  default: "parallel",
});

const SubagentParams = Type.Object({
  mode: Type.Optional(ModeSchema),
  tasks: Type.Array(TaskItem, { description: "Subtasks to run: a list of {agent, task}.", minItems: 1 }),
  agentScope: Type.Optional(AgentScopeSchema),
});

export function registerSubagentTool(pi: ExtensionAPI, deps: SubagentRunnerDeps) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: parallel (default), chain (sequential with {previous} placeholder).",
      `Default agent scope is "user" (from ${path.join(deps.agentDir, "agents")}).`,
      `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const mode: ExecutionMode = params.mode ?? "parallel";
      const agentScope: AgentScope = params.agentScope ?? "user";

      if ((agentScope === "project" || agentScope === "both") && !ctx.isProjectTrusted()) {
        return {
          content: [
            {
              type: "text",
              text: `Project is not trusted: agentScope "${agentScope}" requires a trusted project.`,
            },
          ],
          details: { mode, agentScope, projectAgentsDir: null, results: [] } satisfies SubagentDetails,
          isError: true,
        };
      }

      const discovery = discoverAgents(deps.agentDir, ctx.cwd, agentScope);
      const agents = discovery.agents;
      const makeDetails = (results: SingleResult[]): SubagentDetails => ({
        mode,
        agentScope,
        projectAgentsDir: discovery.projectAgentsDir,
        results,
      });

      const tasks = params.tasks;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return {
          content: [{ type: "text", text: "Invalid parameters: tasks must contain at least one task." }],
          details: makeDetails([]),
          isError: true,
        };
      }
      if (tasks.length > MAX_TASKS) {
        return {
          content: [{ type: "text", text: `Too many tasks (${tasks.length}). Max is ${MAX_TASKS}.` }],
          details: makeDetails([]),
          isError: true,
        };
      }

      const dispatchDefaults: DispatchDefaults = {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinkingLevel: ctx.thinkingLevel,
      };

      if (mode === "chain") {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < tasks.length; i++) {
          const step = tasks[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

          // Combine completed results with the current streaming result.
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
              const currentResult = partial.details?.results[0];
              if (currentResult) {
                const allResults = [...results, currentResult];
                onUpdate({
                  content: partial.content,
                  details: makeDetails(allResults),
                });
              }
            }
            : undefined;

          const result = await runSingleAgent({
            deps,
            ctx,
            agents,
            agentName: step.agent,
            task: taskWithContext,
            dispatchDefaults,
            step: i + 1,
            signal,
            onUpdate: chainUpdate,
            makeDetails,
          });
          results.push(result);

          if (isFailedResult(result)) {
            const errorMsg = await truncateSubagentOutput(getResultOutput(result));
            return {
              content: [{
                type: "text",
                text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`
              }],
              details: makeDetails(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text", text: await truncateSubagentOutput(getFinalOutput(results[results.length - 1]!.messages) || "(no output)") }],
          details: makeDetails(results),
        };
      }

      // Parallel mode
      const allResults: SingleResult[] = tasks.map((t) => ({
        agent: t.agent,
        agentSource: "unknown",
        task: t.task,
        state: { status: "running" },
        messages: [],
        stderr: "",
        usage: emptyUsageStats(),
      }));

      const emitParallelUpdate = () => {
        if (onUpdate) {
          const running = allResults.filter((r) => r.state.status === "running").length;
          const done = allResults.length - running;
          onUpdate({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails([...allResults]),
          });
        }
      };

      const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
        const result = await runSingleAgent({
          deps,
          ctx,
          agents,
          agentName: t.agent,
          task: t.task,
          dispatchDefaults,
          step: undefined,
          signal,
          onUpdate: (partial) => {
            if (partial.details?.results[0]) {
              allResults[index] = partial.details.results[0];
              emitParallelUpdate();
            }
          },
          makeDetails,
        });
        allResults[index] = result;
        emitParallelUpdate();
        return result;
      });

      const successCount = results.filter((r) => !isFailedResult(r)).length;
      const summaries = await Promise.all(
        results.map(async (r) => {
          const output = await truncateSubagentOutput(getResultOutput(r));
          const status = isFailedResult(r)
            ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
            : "completed";
          return `### [${r.agent}] ${status}\n\n${output}`;
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
          },
        ],
        details: makeDetails(results),
      };
    },

    renderCall(args, theme, _context) {
      const scope: AgentScope = args.agentScope ?? "user";
      const mode: ExecutionMode = args.mode ?? "parallel";
      const tasks: { agent: string; task: string }[] = Array.isArray(args.tasks) ? args.tasks : [];
      if (mode === "chain") {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${tasks.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < Math.min(tasks.length, 3); i++) {
          const step = tasks[i];
          // Clean up {previous} placeholder for display
          const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", `parallel (${tasks.length} tasks)`) +
        theme.fg("muted", ` [${scope}]`);
      for (const t of tasks.slice(0, 3)) {
        const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
        text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
      }
      if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      const aggregateUsage = (results: SingleResult[]) => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };

      const isChain = details.mode === "chain";

      const resultIcon = (r: SingleResult) =>
        r.state.status === "running"
          ? theme.fg("warning", "⏳")
          : isFailedResult(r)
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");

      // "─── Step N: agent" for chain steps, "─── agent" for parallel tasks.
      const sectionHeader = (r: SingleResult) =>
        isChain
          ? `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${resultIcon(r)}`
          : `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${resultIcon(r)}`;

      // Expanded block for one result: header, task, tool calls, final output, usage.
      const addExpandedResult = (container: Container, r: SingleResult) => {
        container.addChild(new Spacer(1));
        container.addChild(new Text(sectionHeader(r), 0, 0));
        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
        for (const item of getDisplayItems(r.messages)) {
          if (item.type === "toolCall") {
            container.addChild(
              new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
            );
          }
        }
        const finalOutput = getFinalOutput(r.messages);
        if (finalOutput) {
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
        }
        const usage = formatUsageStats(r.usage, r.model);
        if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
      };

      // Collapsed preview for one result: header plus a capped display-item list.
      const collapsedResultText = (r: SingleResult) => {
        const items = getDisplayItems(r.messages);
        let text = `\n\n${sectionHeader(r)}`;
        if (items.length === 0) text += `\n${theme.fg("muted", r.state.status === "running" ? "(running...)" : "(no output)")}`;
        else text += `\n${renderDisplayItems(items, 5)}`;
        return text;
      };

      const running = details.results.filter((r) => r.state.status === "running").length;
      const failCount = details.results.filter((r) => isFailedResult(r)).length;
      const successCount = details.results.length - running - failCount;
      const isRunning = running > 0;
      // Any task still running shows the hourglass in both modes.
      const icon = isRunning
        ? theme.fg("warning", "⏳")
        : failCount > 0
          ? isChain
            ? theme.fg("error", "✗")
            : theme.fg("warning", "◐")
          : theme.fg("success", "✓");
      const status = isChain
        ? `${successCount}/${details.results.length} steps`
        : isRunning
          ? `${successCount + failCount}/${details.results.length} done, ${running} running`
          : `${successCount}/${details.results.length} tasks`;
      const header = `${icon} ${theme.fg("toolTitle", theme.bold(isChain ? "chain " : "parallel "))}${theme.fg("accent", status)}`;
      const totalUsage = formatUsageStats(aggregateUsage(details.results));

      if (expanded && !isRunning) {
        const container = new Container();
        container.addChild(new Text(header, 0, 0));
        for (const r of details.results) addExpandedResult(container, r);
        if (totalUsage) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
        }
        return container;
      }

      let text = header;
      for (const r of details.results) text += collapsedResultText(r);
      if (!isRunning && totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
      if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}
