/** Inline, selection-only session picker. No permission-prompt subscription or session mutation. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, matchesKey, SelectList, Text,
  type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { singleLineLabel } from "./subagent-browser.ts";
import type { SubagentSession } from "./subagent-sessions.ts";

export class SubagentSessionSelector implements Component {
  private selectedIndex = 0;
  private pageSize = 1;
  private disposed = false;

  constructor(
    private readonly sessions: SubagentSession[],
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly finish: (file: string | undefined) => void,
  ) {}

  invalidate(): void {}
  dispose(): void { this.disposed = true; }

  render(width: number): string[] {
    if (this.disposed || width < 1) return [];
    const compact = () => [truncateToWidth("Window too small · Ctrl+C: close", width, "")];
    if (width < 3) return compact();
    const innerWidth = width - 2;
    const keys = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      this.keybindings.getKeys(action).filter((key) => key !== Key.ctrl("c")).join("/");
    const help = new Text(this.theme.fg("dim", [
      `${keys("tui.select.up")}/${keys("tui.select.down")}: navigate`,
      `${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")}: page`,
      `${keys("tui.select.confirm")}: open`, `${keys("tui.select.cancel")}: cancel`, "Ctrl+C: close",
    ].join(" · ")), 0, 0).render(innerWidth);
    const height = Math.max(1, Math.min(Math.floor(this.tui.terminal.rows * 0.8), this.tui.terminal.rows - 2));
    const available = height - help.length - 6;
    if (available < 1) return compact();
    this.pageSize = Math.max(1, Math.min(10, available, this.sessions.length));
    const list = new SelectList(this.sessions.map((session) => ({
      value: session.file,
      label: this.theme.fg("accent", singleLineLabel(session.agent)) + ` · ${singleLineLabel(session.fileName)}`,
    })), this.pageSize, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => {
        const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(text)));
        return this.theme.bg("selectedBg", text) + this.theme.bg("selectedBg", padding);
      },
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("muted", text),
    });
    list.setSelectedIndex(this.selectedIndex);
    const body = list.render(innerWidth);
    if (this.sessions.length <= this.pageSize) body.push("");
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) => border("│") + truncateToWidth(text, innerWidth, "", true) + border("│");
    const separator = () => border(`├${"─".repeat(innerWidth)}┤`);
    return [
      border(`┌${"─".repeat(innerWidth)}┐`),
      row(this.theme.fg("accent", "Subagent sessions")), separator(),
      ...body.map(row), separator(), ...help.map(row), border(`└${"─".repeat(innerWidth)}┘`),
    ];
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.ctrl("c")) || this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish(undefined);
      return;
    }
    const count = this.sessions.length;
    if (!count) return;
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.finish(this.sessions[this.selectedIndex].file);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.selectedIndex = (this.selectedIndex - 1 + count) % count;
    else if (this.keybindings.matches(data, "tui.select.down")) this.selectedIndex = (this.selectedIndex + 1) % count;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.selectedIndex = Math.max(0, this.selectedIndex - this.pageSize);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.selectedIndex = Math.min(count - 1, this.selectedIndex + this.pageSize);
    } else return;
    this.tui.requestRender();
  }
}

export async function showSubagentSessionSelector(
  pi: ExtensionAPI, ctx: ExtensionContext, sessions: SubagentSession[],
): Promise<string | undefined> {
  let closed = false;
  let finishUI: ((file: string | undefined) => void) | undefined;
  const close = (file?: string) => {
    if (closed) return;
    closed = true;
    finishUI?.(file);
  };
  const unsubscribe = pi.on("session_shutdown", () => close());
  try {
    return await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
      finishUI = done;
      if (closed) {
        done(undefined);
        return { render: () => [], invalidate() {} };
      }
      return new SubagentSessionSelector(sessions, tui, theme, keybindings, close);
    }, { overlay: false });
  } finally {
    closed = true;
    unsubscribe();
  }
}
