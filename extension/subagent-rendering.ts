/** Compact tool summaries and expanded assistant/tool-call rendering. */

import * as os from "node:os";
import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { DisplayItem } from "./result-parsing.ts";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
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
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function parseLineNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function formatReadLineRange(offset: unknown, limit: unknown): string | undefined {
  if (offset == null && limit == null) return undefined;
  const start = offset == null ? 1 : parseLineNumber(offset);
  if (start === undefined) return undefined;
  if (limit == null) return `:${start}`;
  const count = parseLineNumber(limit);
  if (count === undefined) return undefined;
  const end = start + count - 1;
  return `:${start}${end ? `-${end}` : ""}`;
}

function stringArg(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  const filePath = () => shortenPath(stringArg(args.file_path, stringArg(args.path, "...")));
  switch (toolName) {
    case "bash": {
      const command = stringArg(args.command, "...");
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const lineRange = formatReadLineRange(args.offset, args.limit);
      let text = themeFg("accent", filePath());
      if (lineRange) text += themeFg("warning", lineRange);
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const lines = stringArg(args.content).split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath());
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit":
      return themeFg("muted", "edit ") + themeFg("accent", filePath());
    case "ls":
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(stringArg(args.path, ".")));
    case "find":
      return themeFg("muted", "find ") + themeFg("accent", stringArg(args.pattern, "*")) +
        themeFg("dim", ` in ${shortenPath(stringArg(args.path, "."))}`);
    case "grep":
      return themeFg("muted", "grep ") + themeFg("accent", `/${stringArg(args.pattern)}/`) +
        themeFg("dim", ` in ${shortenPath(stringArg(args.path, "."))}`);
    default: {
      let argsStr: string;
      try { argsStr = JSON.stringify(args) ?? "(unavailable arguments)"; } catch { argsStr = "(unavailable arguments)"; }
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

/** No final-output append or text deduplication: each assistant content item appears once, in order. */
export function appendDisplayItems(container: Container, items: readonly DisplayItem[], theme: Theme): void {
  const mdTheme = getMarkdownTheme();
  for (const item of items) {
    if (item.type === "text") {
      container.addChild(new Spacer(1));
      container.addChild(new Markdown(item.text, 0, 0, mdTheme));
    } else {
      container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
    }
  }
}
