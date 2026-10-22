/** Slash-command orchestration. Commands remain available in inspection-only sessions. */

import * as path from "node:path";
import { type ExtensionAPI, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { type BrowserContent, showSubagentBrowser, singleLineLabel } from "./subagent-browser.ts";
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

export function registerSubagentCommands(pi: ExtensionAPI, deps: Pick<SubagentRunnerDeps, "agentDir">): void {
  let interactionActive = false;

  pi.registerCommand("list-subagents", {
    description: "Browse subagent definitions and their parsed metadata.",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("list-subagents requires interactive TUI mode.", "error");
        return;
      }
      if (interactionActive) {
        ctx.ui.notify("A subagent browser is already open.", "error");
        return;
      }
      interactionActive = true;
      try {
        await showSubagentBrowser(pi, ctx, () => definitionContent(deps.agentDir, ctx.cwd, ctx.isProjectTrusted()));
      } finally {
        interactionActive = false;
      }
    },
  });
}
