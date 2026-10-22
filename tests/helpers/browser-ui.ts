/** Deterministic custom-UI harness: no terminal, global theme, timers, or real sessions. */

import type {
  ExtensionContext,
  KeybindingsManager as PiKeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";

type CustomOptions = Parameters<ExtensionContext["ui"]["custom"]>[1];
type DisposableComponent = Component & { dispose?(): void };
type CustomFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: PiKeybindingsManager,
  done: (result: T) => void,
) => DisposableComponent | Promise<DisposableComponent>;

export interface CustomInteraction {
  component?: DisposableComponent;
  options: CustomOptions;
  closed: boolean;
  mounted: boolean;
  doneCalls: number;
  cancel(): void;
}

export class BrowserUI {
  readonly interactions: CustomInteraction[] = [];
  readonly terminal = { rows: 30, columns: 120 };
  renderRequests = 0;
  color = 36;
  beforeFactory?: () => void;
  beforeMount?: () => void;
  readonly keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  readonly theme = {
    fg: (_name: string, text: string) => `\x1b[${this.color}m${text}\x1b[39m`,
    bg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  readonly tui = {
    terminal: this.terminal,
    requestRender: () => { this.renderRequests++; },
  } as unknown as TUI;

  readonly custom = <T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> => new Promise<T>((resolve, reject) => {
    let disposed = false;
    const dispose = () => {
      if (disposed || !interaction.component) return;
      disposed = true;
      interaction.component.dispose?.();
    };
    const done = (value: T) => {
      interaction.doneCalls++;
      if (interaction.closed) return;
      interaction.closed = true;
      interaction.mounted = false;
      dispose();
      resolve(value);
    };
    const interaction: CustomInteraction = {
      options,
      closed: false,
      mounted: false,
      doneCalls: 0,
      cancel: () => done(undefined as never),
    };
    this.interactions.push(interaction);
    try {
      this.beforeFactory?.();
      const created = factory(this.tui, this.theme, this.keybindings as unknown as PiKeybindingsManager, done);
      Promise.resolve(created).then((component) => {
        interaction.component = component;
        this.beforeMount?.();
        if (interaction.closed) dispose();
        else interaction.mounted = true;
      }).catch(reject);
    } catch (error) {
      reject(error);
    }
  });

  cancelAll(): void {
    for (const interaction of this.interactions) {
      if (!interaction.closed) interaction.cancel();
    }
  }
}
