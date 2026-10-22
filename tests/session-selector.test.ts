/** Selection UI tests use local component/theme/event doubles and no filesystem or real TUI. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { showSubagentSessionSelector, SubagentSessionSelector } from "../extension/session-selector.ts";
import type { SubagentSession } from "../extension/subagent-sessions.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { createContext, flushPromises, MockPi } from "./helpers/mocks.ts";

const choices = (count = 16): SubagentSession[] => Array.from({ length: count }, (_, index) => ({
  file: `file-${index}`, fileName: `session-${index}.jsonl`, agent: "worker", created: index, degraded: false,
}));

test("inline selector has bounded single-line choices, native information, paging and path-valued confirmation", () => {
  const ui = new BrowserUI();
  const sessions = choices();
  sessions[0].agent = "worker\x1b[31m\n红";
  const results: (string | undefined)[] = [];
  const selector = new SubagentSessionSelector(sessions, ui.tui, ui.theme, ui.keybindings, (file) => results.push(file));
  const initial = selector.render(100).map(stripTerminalSequences).join("\n");
  assert.match(initial, /worker 红 · session-0.jsonl/);
  assert.match(initial, /\(1\/16\)/);
  assert.doesNotMatch(selector.render(100).join("\n"), /\x1b\[31m/);
  assert.ok(selector.render(100).length <= Math.floor(ui.terminal.rows * 0.8));
  selector.handleInput("\x1b[6~");
  assert.match(selector.render(100).map(stripTerminalSequences).join("\n"), /\(11\/16\)/);
  selector.handleInput("\r");
  assert.deepEqual(results, ["file-10"]);
  selector.dispose();
  selector.handleInput("\r");
  assert.deepEqual(selector.render(100), []);
  assert.deepEqual(results, ["file-10"]);
});

test("selector uses injected keys and fits narrow, short and resized terminals", () => {
  const ui = new BrowserUI();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "space" });
  const results: (string | undefined)[] = [];
  const sessions = choices(2);
  sessions[0].fileName = "中文🙂e\u0301".repeat(30) + ".jsonl";
  const selector = new SubagentSessionSelector(sessions, ui.tui, ui.theme, kb, (file) => results.push(file));
  for (const rows of [1, 6, 15, 30]) {
    ui.terminal.rows = rows;
    for (const width of [1, 2, 3, 12, 30, 100]) {
      const rendered = selector.render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width));
      assert.ok(rendered.length <= Math.max(1, Math.min(Math.floor(rows * 0.8), rows - 2)));
    }
  }
  ui.backgroundColor = 45;
  selector.invalidate();
  assert.ok(selector.render(100).join("\n").includes("\x1b[45m"));
  selector.handleInput("j"); selector.handleInput(" ");
  assert.deepEqual(results, ["file-1"]);
});

test("custom selector is non-overlay, ignores permissions, and unregisters shutdown after cancellation", async () => {
  for (const method of ["escape", "ctrl-c", "shutdown", "external"] as const) {
    const pi = new MockPi();
    const ui = new BrowserUI();
    const { ctx } = createContext();
    ctx.ui.custom = ui.custom;
    const opening = showSubagentSessionSelector(pi.api, ctx, choices());
    await flushPromises();
    const interaction = ui.interactions[0];
    assert.equal(interaction.options?.overlay, false);
    assert.equal(pi.events.count("permissions:ui_prompt"), 0);
    pi.events.emit("permissions:ui_prompt", {});
    assert.equal(interaction.closed, false);
    if (method === "shutdown") await pi.emitLifecycle("session_shutdown", ctx, "reload");
    else if (method === "external") interaction.cancel();
    else interaction.component!.handleInput!(method === "escape" ? "\x1b" : "\x03");
    assert.equal(await opening, undefined);
    assert.equal(pi.count("session_shutdown"), 0);
    assert.equal(interaction.doneCalls, 1);
    await pi.emitLifecycle("session_shutdown", ctx, "reload");
    assert.equal(interaction.doneCalls, 1);
  }
});

test("shutdown before selector factory or mounting cannot leave a late inline UI", async () => {
  for (const hook of ["beforeFactory", "beforeMount"] as const) {
    const pi = new MockPi();
    const ui = new BrowserUI();
    const { ctx } = createContext();
    ctx.ui.custom = ui.custom;
    let shutdown: Promise<unknown[]> | undefined;
    ui[hook] = () => { shutdown = pi.emitLifecycle("session_shutdown", ctx, "reload"); };
    const opening = showSubagentSessionSelector(pi.api, ctx, choices());
    await flushPromises();
    await shutdown;
    assert.equal(await opening, undefined);
    assert.equal(ui.interactions[0].mounted, false);
    assert.equal(ui.interactions[0].doneCalls, 1);
    assert.equal(pi.count("session_shutdown"), 0);
  }
});
