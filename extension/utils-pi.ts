/** Shared utilities that depend on Pi host functionality. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, type KeybindingsManager, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const KEY_LABELS: Record<string, string> = {
  up: "↑", down: "↓", pageUp: "PgUp", pageDown: "PgDn", enter: "Enter", return: "Enter",
  escape: "Esc", esc: "Esc", space: "Space",
};

/** Labels are terminal text, never Markdown or executable terminal sequences. */
export function singleLineLabel(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
}

/** Format bound key aliases, optionally omitting Ctrl+C when it has a separate close hint. */
export function formatKeybindingKeys(
  keybindings: KeybindingsManager, action: Parameters<KeybindingsManager["getKeys"]>[0], excludeCtrlC: boolean,
): string {
  return keybindings.getKeys(action)
    .filter((key) => !excludeCtrlC || key !== Key.ctrl("c"))
    .map((key) => KEY_LABELS[key] ?? key).join("/") || "(unbound)";
}

/** Render the compact fallback for a custom UI that does not fit the available space. */
export function renderWindowTooSmall(theme: Theme, width: number): string[] {
  return [truncateToWidth(theme.fg("muted", "Window too small · Ctrl+C: close"), width, "")];
}
