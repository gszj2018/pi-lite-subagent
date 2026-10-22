/** List/detail overlays owned by ctx.ui.custom, with permission-prompt preemption. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  type KeybindingsManager,
  matchesKey,
  SelectList,
  stripTerminalSequences,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface BrowserItem {
  id: string;
  label: string;
  createDetail(theme: Theme): Component;
}

export interface BrowserContent {
  title: string;
  items: BrowserItem[];
  emptyMessage: string;
}

/** Labels are terminal text, never Markdown or executable terminal sequences. */
export function singleLineLabel(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
}

/** Overlay maxHeight clips rather than scrolls, so the browser owns its viewport. */
export class SubagentBrowser implements Component {
  private selectedIndex = 0;
  private showingDetail = false;
  private scrollTop = 0;
  private viewportHeight = 1;
  private list?: SelectList;
  private listHeight = 0;
  private detail?: Component;
  private detailWidth?: number;
  private detailLines?: string[];
  private disposed = false;

  constructor(
    private readonly content: BrowserContent,
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly close: () => void,
  ) {}

  invalidate(): void {
    this.list = undefined;
    this.detail?.invalidate();
    this.detail = undefined;
    this.detailLines = undefined;
    this.detailWidth = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }

  private get height(): number {
    const rows = this.tui.terminal.rows;
    return Math.max(1, Math.min(Math.floor(rows * 0.8), rows - 2));
  }

  private get selected(): BrowserItem | undefined {
    return this.content.items[this.selectedIndex];
  }

  private getDetailLines(width: number): string[] {
    if (this.detailLines && this.detailWidth === width) return this.detailLines;
    try {
      this.detail ??= this.selected?.createDetail(this.theme) ?? new Text("(no output)", 0, 0);
      this.detailLines = this.detail.render(width);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.detail = new Text(this.theme.fg("error", `Cannot display item: ${singleLineLabel(message)}`), 0, 0);
      this.detailLines = this.detail.render(width);
    }
    this.detailWidth = width;
    return this.detailLines;
  }

  private renderList(width: number, height: number): string[] | undefined {
    if (height < 2) return undefined;
    // Always reserve one row for SelectList's scroll information or an empty placeholder.
    const visible = Math.max(1, Math.min(height - 1, this.content.items.length));
    if (!this.list || visible !== this.listHeight) {
      this.listHeight = visible;
      this.list = new SelectList(
        this.content.items.map((item) => ({ value: item.id, label: singleLineLabel(item.label) })),
        visible,
        {
          selectedPrefix: (text) => this.theme.fg("accent", text),
          selectedText: (text) => this.theme.fg("accent", text),
          description: (text) => this.theme.fg("muted", text),
          scrollInfo: (text) => this.theme.fg("dim", text),
          noMatch: (text) => this.theme.fg("muted", text),
        },
      );
    }
    this.list.setSelectedIndex(this.selectedIndex);
    const lines = this.list.render(width);
    return this.content.items.length > visible ? lines : [...lines, ""];
  }

  private helpText(): string {
    const key = (action: Parameters<KeybindingsManager["getKeys"]>[0]) => {
      const names: Record<string, string> = {
        up: "↑", down: "↓", pageUp: "PgUp", pageDown: "PgDn", enter: "Enter", return: "Enter",
        escape: "Esc", esc: "Esc", space: "Space",
      };
      return this.keybindings.getKeys(action)
        .filter((name) => action !== "tui.select.cancel" || name !== Key.ctrl("c"))
        .map((name) => names[name] ?? name).join("/") || "(unbound)";
    };
    return [
      `${key("tui.select.up")}/${key("tui.select.down")}: ${this.showingDetail ? "scroll" : "navigate"}`,
      `${key("tui.select.pageUp")}/${key("tui.select.pageDown")}: page`,
      this.showingDetail ? "Home/End: first/last" : `${key("tui.select.confirm")}: view`,
      `${key("tui.select.cancel")}: ${this.showingDetail ? "back" : "close"}`,
      "Ctrl+C: close",
    ].join(" · ");
  }

  render(width: number): string[] {
    if (this.disposed || width < 1) return [];
    const height = this.height;
    const compact = () => [truncateToWidth(this.theme.fg("muted", "Window too small · Ctrl+C: close"), width, "")];
    if (width < 3) return compact();

    const innerWidth = width - 2;
    const body = this.showingDetail ? this.getDetailLines(innerWidth) : [];
    // Reserve a stable maximum range width so scrolling cannot change the footer/body height.
    const rangeWidth = visibleWidth(`${body.length}–${body.length}/${body.length}`);
    const showRange = this.showingDetail && innerWidth >= rangeWidth + 2 + 16;
    const helpWidth = showRange ? innerWidth - rangeWidth - 2 : innerWidth;
    const help = new Text(this.theme.fg("dim", this.helpText()), 0, 0).render(helpWidth);
    // Borders/separators and the fixed title/footer are measured outside the content viewport.
    const available = height - help.length - (this.showingDetail ? 7 : 5);
    if (available < 1) return compact();

    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) => border("│") + truncateToWidth(text, innerWidth, "", true) + border("│");
    const separator = () => border(`├${"─".repeat(innerWidth)}┤`);
    const lines = [
      border(`┌${"─".repeat(innerWidth)}┐`),
      row(this.theme.fg("accent", singleLineLabel(this.content.title))),
      separator(),
    ];
    if (!this.showingDetail) {
      const list = this.renderList(innerWidth, available);
      if (!list) return compact();
      lines.push(...list.map(row));
    } else {
      const selectedLabel = singleLineLabel(this.selected?.label ?? "");
      lines.push(row(this.theme.fg("accent", selectedLabel)), separator());
      this.viewportHeight = available;
      this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - this.viewportHeight));
      // This is the explicit body viewport, not removal of component-specific decoration rows.
      lines.push(...body.slice(this.scrollTop, this.scrollTop + this.viewportHeight).map(row));
      if (showRange) {
        const start = body.length === 0 ? 0 : this.scrollTop + 1;
        const end = Math.min(body.length, this.scrollTop + this.viewportHeight);
        const range = `${start}–${end}/${body.length}`;
        const last = help.length - 1;
        const gap = innerWidth - visibleWidth(help[last]) - visibleWidth(range);
        help[last] += " ".repeat(Math.max(1, gap)) + this.theme.fg("dim", range);
      }
    }
    lines.push(separator(), ...help.map(row), border(`└${"─".repeat(innerWidth)}┘`));
    return lines;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (!this.showingDetail) {
        this.close();
        return;
      }
      this.showingDetail = false;
    } else if (this.showingDetail) {
      const page = Math.max(1, this.viewportHeight);
      if (this.keybindings.matches(data, "tui.select.up")) this.scrollTop--;
      else if (this.keybindings.matches(data, "tui.select.down")) this.scrollTop++;
      else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scrollTop -= page;
      else if (this.keybindings.matches(data, "tui.select.pageDown")) this.scrollTop += page;
      else if (matchesKey(data, Key.home)) this.scrollTop = 0;
      else if (matchesKey(data, Key.end)) this.scrollTop = this.detailLines?.length ?? 0;
      else return;
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, (this.detailLines?.length ?? 0) - page)));
    } else {
      const count = this.content.items.length;
      if (!count) return;
      if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.showingDetail = true;
        this.scrollTop = 0;
        this.detail = undefined;
        this.detailLines = undefined;
      } else if (this.keybindings.matches(data, "tui.select.up")) {
        this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      } else if (this.keybindings.matches(data, "tui.select.down")) {
        this.selectedIndex = (this.selectedIndex + 1) % count;
      } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
        this.selectedIndex = Math.max(0, this.selectedIndex - Math.max(1, this.listHeight));
      } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
        this.selectedIndex = Math.min(count - 1, this.selectedIndex + Math.max(1, this.listHeight));
      } else return;
    }
    this.tui.requestRender();
  }
}

/** Collect content synchronously after installing cancellation, then await the custom UI interaction. */
export async function showSubagentBrowser(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  load: () => BrowserContent,
): Promise<void> {
  let closed = false;
  let finishUI: (() => void) | undefined;
  const disposers: (() => void)[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    for (const dispose of disposers.splice(0)) dispose();
    // done() removes the component synchronously, before a permission dialog opens.
    finishUI?.();
  };

  try {
    disposers.push(pi.events.on("permissions:ui_prompt", close));
    disposers.push(pi.on("session_shutdown", close));
    const content = load();
    if (closed) return;
    if (content.items.length === 0) {
      ctx.ui.notify(content.emptyMessage, "info");
      return;
    }
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
      finishUI = () => done(undefined);
      if (closed) {
        finishUI();
        return { render: () => [], invalidate() {} };
      }
      return new SubagentBrowser(content, tui, theme, keybindings, close);
    }, {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%", margin: 1 },
    });
  } catch (error) {
    if (!closed) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Cannot open subagent browser: ${singleLineLabel(message)}`, "error");
    }
  } finally {
    close();
  }
}
