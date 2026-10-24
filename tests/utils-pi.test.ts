/** Pure UI-helper tests use local keybindings/theme doubles, without a terminal or global state. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type KeybindingsManager, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { formatKeybindingKeys, renderWindowTooSmall, singleLineLabel } from "../extension/utils-pi.ts";

type KeybindingAction = Parameters<KeybindingsManager["getKeys"]>[0];

function keybindingsFor(keys: string[], expectedAction: KeybindingAction): KeybindingsManager {
  return {
    getKeys(action: KeybindingAction) {
      assert.equal(action, expectedAction);
      return keys;
    },
  } as unknown as KeybindingsManager;
}

test("labels remove terminal sequences and flatten control characters without losing wide text", () => {
  assert.equal(singleLineLabel(" name\x1b[31m红\x1b[0m\nnext\tend\x07 "), "name红 next end");
  assert.equal(singleLineLabel("\x1b]8;;https://example.test\x07label\x1b]8;;\x07"), "label");
});

test("labels preserve Unicode text and flatten line separators while allowing empty cleaned output", () => {
  const cases = [
    ["中文🙂e\u0301", "中文🙂e\u0301"],
    ["first\u2028second\u2029third", "first second third"],
    ["", ""], [" \n\t ", ""], ["\x1b[31m\x1b[0m", ""],
  ];
  for (const [value, expected] of cases) assert.equal(singleLineLabel(value), expected);
});

test("key hints format aliases in binding order and preserve unmapped key names without changing bindings", () => {
  const keys = ["up", "down", "pageUp", "pageDown", "enter", "return", "escape", "esc", "space", "j", "alt+x"];
  const before = [...keys];
  const keybindings = keybindingsFor(keys, "tui.select.up");
  assert.equal(formatKeybindingKeys(keybindings, "tui.select.up", false),
    "↑/↓/PgUp/PgDn/Enter/Enter/Esc/Esc/Space/j/alt+x");
  assert.deepEqual(keys, before);
});

test("key hints filter Ctrl+C only when requested, independently of the action", () => {
  for (const action of ["tui.select.cancel", "tui.select.confirm"] as const) {
    const keybindings = keybindingsFor(["escape", "ctrl+c", "q"], action);
    assert.equal(formatKeybindingKeys(keybindings, action, false), "Esc/ctrl+c/q");
    assert.equal(formatKeybindingKeys(keybindings, action, true), "Esc/q");
  }
});

test("key hints show the unbound fallback for missing bindings or an entirely filtered binding", () => {
  const action = "tui.select.cancel";
  const empty = keybindingsFor([], action);
  assert.equal(formatKeybindingKeys(empty, action, false), "(unbound)");
  assert.equal(formatKeybindingKeys(empty, action, true), "(unbound)");
  const ctrlC = keybindingsFor(["ctrl+c"], action);
  assert.equal(formatKeybindingKeys(ctrlC, action, false), "ctrl+c");
  assert.equal(formatKeybindingKeys(ctrlC, action, true), "(unbound)");
});

test("small-window hints use the injected muted color and truncate to a single line at the available width", () => {
  let color = 35;
  const theme = {
    fg(name: string, text: string) {
      assert.equal(name, "muted");
      return `\x1b[${color}m${text}\x1b[39m`;
    },
  } as unknown as Theme;
  const message = "Window too small · Ctrl+C: close";
  for (const width of [1, 8, 20, 80]) {
    const lines = renderWindowTooSmall(theme, width);
    assert.equal(lines.length, 1);
    assert.equal(stripTerminalSequences(lines[0]), message.slice(0, width));
    assert.ok(visibleWidth(lines[0]) <= width);
  }
  assert.deepEqual(renderWindowTooSmall(theme, 80), [`\x1b[35m${message}\x1b[39m`]);
  color = 36;
  assert.deepEqual(renderWindowTooSmall(theme, 80), [`\x1b[36m${message}\x1b[39m`]);
});
