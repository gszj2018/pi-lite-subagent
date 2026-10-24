/** Inline, selection-only session picker. No permission-prompt subscription or session mutation. */

import { DynamicBorder, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, matchesKey, SelectList, Text,
  type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentSession } from "./subagent-sessions.ts";
import { formatKeybindingKeys, renderWindowTooSmall, singleLineLabel } from "./utils-pi.ts";

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
    if (width < 3) return renderWindowTooSmall(this.theme, width);
    const innerWidth = width - 2;
    const keys = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      formatKeybindingKeys(this.keybindings, action, true);
    const hint = (key: string, description: string) =>
      this.theme.fg("dim", key) + this.theme.fg("muted", ` ${description}`);
    const help = new Text([
      hint(`${keys("tui.select.up")}/${keys("tui.select.down")}`, "navigate"),
      hint(`${keys("tui.select.pageUp")}/${keys("tui.select.pageDown")}`, "page"),
      hint(keys("tui.select.confirm"), "open"), hint(keys("tui.select.cancel"), "cancel"), hint("Ctrl+C", "close"),
    ].join("  "), 0, 0).render(innerWidth);
    const height = Math.max(1, Math.min(Math.floor(this.tui.terminal.rows * 0.8), this.tui.terminal.rows - 2));
    // Two horizontal borders, a title, four spacers, and at most one native list information row.
    const available = height - help.length - 8;
    if (available < 1) return renderWindowTooSmall(this.theme, width);
    this.pageSize = Math.max(1, Math.min(10, available, this.sessions.length));
    const list = new SelectList(this.sessions.map((session, index) => {
      const task = singleLineLabel(session.task ?? "");
      const label = `${singleLineLabel(session.agent)} · ${task || singleLineLabel(session.fileName)}`;
      return {
        value: session.file,
        label: index === this.selectedIndex ? label : this.theme.fg("text", label),
      };
    }), this.pageSize, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("muted", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("muted", text),
    });
    list.setSelectedIndex(this.selectedIndex);
    const body = list.render(innerWidth);
    const [border] = new DynamicBorder((text) => this.theme.fg("border", text)).render(width);
    const row = (text: string) => " " + truncateToWidth(text, innerWidth, "");
    return [
      border, "", row(this.theme.fg("accent", this.theme.bold("Subagent sessions"))), "",
      ...body.map(row), "", ...help.map(row), "", border,
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
