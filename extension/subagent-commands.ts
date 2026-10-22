/** Slash-command orchestration. Commands remain available in inspection-only sessions. */

import * as path from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { type BrowserContent, showSubagentBrowser, singleLineLabel } from "./subagent-browser.ts";
import { type HistoryTask, registerSubagentHistory } from "./subagent-history.ts";
import { appendDisplayItems, formatUsageStats } from "./subagent-rendering.ts";
import type { SubagentRunnerDeps } from "./types.ts";

function definitionDetail(agent: AgentConfig, theme: Theme): Container {
  const container = new Container();
  const fields: [string, string][] = [
    ["Name", agent.name],
    ["Description", agent.description],
    ["Scope", agent.source],
    ["File", agent.filePath],
  ];
  if (agent.tools) fields.push(["Tools", agent.tools.join(", ")]);
  if (agent.model !== undefined) fields.push(["Model", agent.model]);
  if (agent.thinking !== undefined) fields.push(["Thinking", agent.thinking]);
  for (const [name, value] of fields) {
    container.addChild(new Text(theme.fg("muted", `${name}: `) + singleLineLabel(value), 0, 0));
  }
  if (agent.systemPrompt) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(stripTerminalSequences(agent.systemPrompt), 0, 0, getMarkdownTheme()));
  }
  return container;
}

function compareDefinitions(a: AgentConfig, b: AgentConfig): number {
  const first = a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return first || path.basename(a.filePath).localeCompare(path.basename(b.filePath));
}

function definitionContent(agentDir: string, cwd: string, trusted: boolean): BrowserContent {
  // Separate calls preserve same-name definitions across scopes. Never read untrusted project definitions.
  const user = discoverAgents(agentDir, cwd, "user").agents.sort(compareDefinitions);
  const project = trusted ? discoverAgents(agentDir, cwd, "project").agents.sort(compareDefinitions) : [];
  const range = trusted ? "user + project" : "user only: project not trusted";
  return {
    title: `Subagent definitions [${range}]`,
    emptyMessage: `No subagent definitions found [${range}].`,
    items: [...user, ...project].map((agent) => ({
      id: `${agent.source}:${agent.filePath}`,
      label: `${agent.name} (${agent.source}) · ${agent.description}`,
      createDetail: (theme) => definitionDetail(agent, theme),
    })),
  };
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
    items: tasks.map((task) => ({
      id: task.id,
      label: `${task.agent} · ${task.mode === "chain" ? task.task.replace(/\{previous\}/g, "").trim() : task.task}`,
      createDetail: (theme) => historyDetail(task, theme),
    })),
  };
}

export function registerSubagentCommands(pi: ExtensionAPI, deps: Pick<SubagentRunnerDeps, "agentDir">): void {
  let interactionActive = false;
  const history = registerSubagentHistory(pi);
  const registerBrowser = (
    name: string,
    description: string,
    load: (ctx: ExtensionCommandContext) => BrowserContent,
    subscribe?: (refresh: () => void) => () => void,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (_args, ctx) => {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(`${name} requires interactive TUI mode.`, "error");
          return;
        }
        if (interactionActive) {
          ctx.ui.notify("A subagent browser is already open.", "error");
          return;
        }
        interactionActive = true;
        try {
          await showSubagentBrowser(pi, ctx, () => load(ctx), subscribe);
        } finally {
          interactionActive = false;
        }
      },
    });
  };
  registerBrowser("list-subagents", "Browse subagent definitions and their parsed metadata.",
    (ctx) => definitionContent(deps.agentDir, ctx.cwd, ctx.isProjectTrusted()));
  registerBrowser("view-subagents", "Browse subagent execution status and results on the active branch.",
    (ctx) => historyContent(history.read(ctx)), history.subscribe);
}
