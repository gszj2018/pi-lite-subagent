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

  private renderList(width: number, height: number): string[] {
    const visible = Math.max(1, Math.min(height, this.content.items.length));
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
    // SelectList's extra scroll-info row belongs in our title, not below the options.
    return this.list.render(Math.max(1, width)).slice(0, visible);
  }

  render(width: number): string[] {
    if (this.disposed || width < 1) return [];
    const height = this.height;
    const title = `${singleLineLabel(this.content.title)} · ${this.selectedIndex + 1}/${this.content.items.length}` +
      (this.showingDetail ? " · Esc: back" : "");
    if (width < 3 || height < 3) {
      return [truncateToWidth(this.theme.fg("accent", title), width, "")];
    }

    const innerWidth = width - 2;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text: string) => border("│") + truncateToWidth(text, innerWidth, "", true) + border("│");
    const lines = [border("╭") + truncateToWidth(this.theme.fg("accent", title), innerWidth, "", true) + border("╮")];
    if (!this.showingDetail) {
      lines.push(...this.renderList(innerWidth, height - 2).map(row));
    } else {
      lines.push(row(this.theme.fg("accent", singleLineLabel(this.selected?.label ?? ""))));
      this.viewportHeight = Math.max(0, height - 4);
      if (height > 3) lines.push(border(`├${"─".repeat(innerWidth)}┤`));
      const body = this.getDetailLines(innerWidth);
      this.scrollTop = Math.min(this.scrollTop, Math.max(0, body.length - this.viewportHeight));
      lines.push(...body.slice(this.scrollTop, this.scrollTop + this.viewportHeight).map(row));
    }
    lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
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
