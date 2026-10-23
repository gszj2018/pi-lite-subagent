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

import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { emptyUsageStats, isFailedResult, runSingleAgent } from "./run-agent.ts";
import { appendDisplayItems, type DisplayItem, formatToolCall, formatUsageStats, getDisplayItems } from "./subagent-rendering.ts";
import { truncateSubagentOutput } from "./truncation.ts";
import type {
  DispatchDefaults,
  OnUpdateCallback,
  SingleResult,
  SubagentDetails,
  SubagentRunnerDeps,
  AgentScope
} from "./types.ts";
import { mapWithConcurrencyLimit } from "./utils.ts";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;

type ExecutionMode = "parallel" | "chain";

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

          const { result, output } = await runSingleAgent({
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
            const errorMsg = await truncateSubagentOutput(output);
            return {
              content: [{
                type: "text",
                text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`
              }],
              details: makeDetails(results),
              isError: true,
            };
          }
          previousOutput = output;
        }
        return {
          content: [{ type: "text", text: await truncateSubagentOutput(previousOutput || "(no output)") }],
          details: makeDetails(results),
        };
      }

      // Parallel mode
      const allResults: SingleResult[] = tasks.map((t) => ({
        agent: t.agent,
        agentSource: "unknown",
        task: t.task,
        exitCode: undefined,
        messages: [],
        stderr: "",
        usage: emptyUsageStats(),
      }));

      const emitParallelUpdate = () => {
        if (onUpdate) {
          const running = allResults.filter((r) => r.exitCode === undefined).length;
          const done = allResults.length - running;
          onUpdate({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails([...allResults]),
          });
        }
      };

      const runResults = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
        const { result, output } = await runSingleAgent({
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
        return { result, output };
      });

      const results = runResults.map((r) => r.result);
      const successCount = results.filter((r) => !isFailedResult(r)).length;
      const summaries = await Promise.all(
        runResults.map(async (run) => {
          const r = run.result;
          const output = await truncateSubagentOutput(run.output);
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

    renderCall(args, theme, { expanded }) {
      const scope: AgentScope = args.agentScope ?? "user";
      const mode: ExecutionMode = args.mode ?? "parallel";
      const tasks: { agent: string; task: string }[] = Array.isArray(args.tasks) ? args.tasks : [];
      if (mode === "chain") {
        let text =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `chain (${tasks.length} steps)`) +
          theme.fg("muted", ` [${scope}]`);
        for (let i = 0; i < (expanded ? tasks.length : Math.min(tasks.length, 3)); i++) {
          const step = tasks[i];
          const displayTask = expanded ? step.task : step.task.replace(/\{previous\}/g, "").trim();
          const preview = !expanded && displayTask.length > 40 ? `${displayTask.slice(0, 40)}...` : displayTask;
          text +=
            "\n  " +
            theme.fg("muted", `${i + 1}.`) +
            " " +
            theme.fg("accent", step.agent) +
            theme.fg("dim", ` ${preview}`);
        }
        if (!expanded && tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", `parallel (${tasks.length} tasks)`) +
        theme.fg("muted", ` [${scope}]`);
      for (const t of expanded ? tasks : tasks.slice(0, 3)) {
        const preview = !expanded && t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
        text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
      }
      if (!expanded && tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

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
        r.exitCode === undefined
          ? theme.fg("warning", "⏳")
          : isFailedResult(r)
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");

      // "─── Step N: agent" for chain steps, "─── agent" for parallel tasks.
      const sectionHeader = (r: SingleResult) =>
        isChain
          ? `${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${resultIcon(r)}`
          : `${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${resultIcon(r)}`;

      // Expanded block for one result: header, task, ordered assistant text/tool calls, usage.
      const addExpandedResult = (container: Container, r: SingleResult) => {
        container.addChild(new Spacer(1));
        container.addChild(new Text(sectionHeader(r), 0, 0));
        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
        appendDisplayItems(container, getDisplayItems(r.messages), theme);
        const usage = formatUsageStats(r.usage, r.model);
        if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
      };

      // Collapsed preview for one result: header plus a capped display-item list.
      const collapsedResultText = (r: SingleResult) => {
        const items = getDisplayItems(r.messages);
        let text = `\n\n${sectionHeader(r)}`;
        if (items.length === 0) text += `\n${theme.fg("muted", r.exitCode === undefined ? "(running...)" : "(no output)")}`;
        else text += `\n${renderDisplayItems(items, 5)}`;
        return text;
      };

      const running = details.results.filter((r) => r.exitCode === undefined).length;
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
