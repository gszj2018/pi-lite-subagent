import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { KeybindingsManager, Text, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  type BrowserContent,
  showSubagentBrowser,
  singleLineLabel,
  SubagentBrowser,
} from "../extension/subagent-browser.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { createContext, flushPromises, MockPi } from "./helpers/mocks.ts";

const keys = {
  down: "\x1b[B", up: "\x1b[A", enter: "\r", escape: "\x1b", ctrlC: "\x03",
  pageDown: "\x1b[6~", pageUp: "\x1b[5~", home: "\x1b[H", end: "\x1b[F",
};

function content(count = 12): BrowserContent {
  return {
    title: "Test browser [user + project]",
    emptyMessage: "No test items.",
    items: Array.from({ length: count }, (_, index) => ({
      id: `item-${index}`,
      label: `agent-${index} · task-${index}`,
      createDetail: () => new Text(Array.from({ length: 60 }, (_, i) => `line-${i + 1}`).join("\n"), 0, 0),
    })),
  };
}

function plain(browser: { render(width: number): string[] }, width = 100): string[] {
  return browser.render(width).map(stripTerminalSequences);
}

function interaction(t: TestContext) {
  const pi = new MockPi();
  const ui = new BrowserUI();
  const mock = createContext();
  mock.ctx.ui.custom = ui.custom;
  t.after(() => {
    pi.events.emit("permissions:ui_prompt", {});
    ui.cancelAll();
  });
  return { pi, ui, ...mock };
}

function assertReleased(pi: MockPi): void {
  assert.equal(pi.events.count("permissions:ui_prompt"), 0);
  assert.equal(pi.count("session_shutdown"), 0);
}

test("labels remove terminal sequences and flatten control characters without losing wide text", () => {
  assert.equal(singleLineLabel(" name\x1b[31m红\x1b[0m\nnext\tend\x07 "), "name红 next end");
  assert.equal(singleLineLabel("\x1b]8;;https://example.test\x07label\x1b]8;;\x07"), "label");
});

test("the browser has a compact list and preserves its selected item after visiting details", () => {
  const ui = new BrowserUI();
  ui.terminal.rows = 15;
  let closes = 0;
  const browser = new SubagentBrowser(content(), ui.tui, ui.theme, ui.keybindings, () => { closes++; });
  const initial = plain(browser);
  assert.match(initial[0], /user \+ project/);
  assert.equal(initial.length, 12, "only title, ten option rows and bottom border are shown");
  assert.doesNotMatch(initial.join("\n"), /line-1|navigate|select|cancel/);
  browser.handleInput(keys.pageDown);
  const selectedList = plain(browser);
  assert.match(selectedList[0], /11\/12/);
  browser.handleInput(keys.enter);
  const detail = plain(browser);
  assert.match(detail[0], /Esc: back/);
  assert.match(detail[1], /agent-10/);
  assert.match(detail[3], /line-1\s/);
  browser.handleInput(keys.down);
  assert.match(plain(browser)[1], /agent-10/, "detail arrows never select another item");
  browser.handleInput(keys.escape);
  assert.deepEqual(plain(browser), selectedList, "selection and centered list range are preserved");
  browser.handleInput(keys.escape);
  assert.equal(closes, 1);
});

test("details scroll and page while their title and selected row stay fixed", () => {
  const ui = new BrowserUI();
  ui.terminal.rows = 15;
  const browser = new SubagentBrowser(content(1), ui.tui, ui.theme, ui.keybindings, () => {});
  browser.handleInput(keys.enter);
  const start = plain(browser);
  browser.handleInput(keys.down);
  assert.match(plain(browser)[3], /line-2\s/);
  browser.handleInput(keys.up);
  assert.deepEqual(plain(browser), start);
  browser.handleInput(keys.pageDown);
  const page = plain(browser);
  assert.deepEqual(page.slice(0, 3), start.slice(0, 3));
  assert.match(page[3], /line-9\s/);
  browser.handleInput(keys.pageUp);
  assert.deepEqual(plain(browser), start);
  browser.handleInput(keys.end);
  assert.match(plain(browser).at(-2)!, /line-60\s/);
  browser.handleInput(keys.home);
  assert.deepEqual(plain(browser), start);
  browser.handleInput(keys.up);
  assert.deepEqual(plain(browser), start, "scroll offsets cannot become negative");
});

test("long labels are one line, and narrow or resized terminals never overflow", () => {
  const ui = new BrowserUI();
  const data = content(4);
  data.items[0].label = "中文🙂e\u0301".repeat(30) + "\nHIDDEN-END";
  const browser = new SubagentBrowser(data, ui.tui, ui.theme, ui.keybindings, () => {});
  assert.doesNotMatch(plain(browser, 30).join("\n"), /HIDDEN-END/);
  for (const detail of [false, true]) {
    if (detail) browser.handleInput(keys.enter);
    for (const rows of [1, 2, 4, 6, 15, 30]) {
      ui.terminal.rows = rows;
      for (const width of [1, 2, 3, 5, 15, 40]) {
        const rendered = browser.render(width);
        assert.ok(rendered.every((line) => visibleWidth(line) <= width), `${rows} rows, ${width} columns`);
        assert.ok(rendered.length <= Math.max(1, Math.min(Math.floor(rows * 0.8), rows - 2)));
      }
    }
  }
  ui.terminal.rows = 15;
  plain(browser);
  browser.handleInput(keys.end);
  plain(browser);
  ui.terminal.rows = 30;
  assert.match(plain(browser).at(-2)!, /line-60\s/, "resizing clamps the body offset to its new viewport");
});

test("detail layout is cached by width and rebuilt on theme invalidation", () => {
  const ui = new BrowserUI();
  let created = 0;
  let rendered = 0;
  const data = content(1);
  data.items[0].createDetail = (theme) => {
    created++;
    const text = new Text(theme.fg("accent", "theme-sensitive body"), 0, 0);
    return { render: (width) => { rendered++; return text.render(width); }, invalidate: () => text.invalidate() };
  };
  const browser = new SubagentBrowser(data, ui.tui, ui.theme, ui.keybindings, () => {});
  browser.handleInput(keys.enter);
  browser.render(70);
  browser.render(70);
  assert.equal(created, 1);
  assert.equal(rendered, 1);
  browser.render(50);
  assert.equal(created, 1);
  assert.equal(rendered, 2);
  ui.color = 35;
  browser.invalidate();
  const changed = browser.render(50);
  assert.equal(created, 2);
  assert.ok(changed[3].includes("\x1b[35m"));
  assert.ok(!changed[3].includes("\x1b[36m"));
  const requests = ui.renderRequests;
  browser.dispose();
  browser.handleInput(keys.down);
  assert.deepEqual(browser.render(50), []);
  assert.equal(ui.renderRequests, requests, "disposed components cannot request renders");
});

test("browser input uses the injected selection keybindings", () => {
  const ui = new BrowserUI();
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "space" });
  const browser = new SubagentBrowser(content(2), ui.tui, ui.theme, kb, () => {});
  browser.handleInput(keys.down);
  assert.match(plain(browser)[0], /1\/2/);
  browser.handleInput("j");
  browser.handleInput(" ");
  assert.match(plain(browser)[1], /agent-1/);
});

test("detail construction errors remain readable and allow returning to the list", () => {
  const ui = new BrowserUI();
  const data = content(1);
  data.items[0].createDetail = () => { throw new Error("broken detail"); };
  const browser = new SubagentBrowser(data, ui.tui, ui.theme, ui.keybindings, () => {});
  browser.handleInput(keys.enter);
  assert.match(plain(browser).join("\n"), /Cannot display item: broken detail/);
  browser.handleInput(keys.escape);
  assert.doesNotMatch(plain(browser).join("\n"), /broken detail/);
});

test("permission preemption closes an open list or detail synchronously and only once", async (t) => {
  const { pi, ctx, ui, notifications } = interaction(t);
  for (const detail of [false, true]) {
    const opening = showSubagentBrowser(pi.api, ctx, () => content());
    assert.equal(pi.events.count("permissions:ui_prompt"), 1, "subscribe before collecting content");
    await flushPromises();
    const current = ui.interactions.at(-1)!;
    assert.equal(current.options?.overlay, true);
    assert.deepEqual(current.options?.overlayOptions, {
      anchor: "center", width: "90%", maxHeight: "80%", margin: 1,
    });
    assert.equal(current.mounted, true);
    if (detail) current.component!.handleInput!(keys.enter);
    current.component!.render(100);
    pi.events.emit("permissions:ui_prompt", { forwarding: { requesterAgentName: "worker" } });
    assert.equal(current.closed, true, "the dialog is closed before emit returns");
    assert.equal(current.doneCalls, 1);
    assertReleased(pi);
    pi.events.emit("permissions:ui_prompt", {});
    current.component!.handleInput!(keys.ctrlC);
    await opening;
    assert.equal(current.doneCalls, 1);
  }
  assert.deepEqual(notifications, []);
});

test("content is collected synchronously after cancellation listeners are installed", async (t) => {
  const { pi, ctx, ui } = interaction(t);
  let loads = 0;
  const opening = showSubagentBrowser(pi.api, ctx, () => {
    loads++;
    assert.equal(pi.events.count("permissions:ui_prompt"), 1);
    assert.equal(pi.count("session_shutdown"), 1);
    return content();
  });
  assert.equal(loads, 1, "load is called before showSubagentBrowser returns its promise");
  assert.equal(ui.interactions.length, 1);
  pi.events.emit("permissions:ui_prompt", null);
  assert.equal(ui.interactions[0].closed, true);
  await opening;
  await flushPromises();
  assert.equal(ui.interactions[0].mounted, false);
  assertReleased(pi);
});

test("a permission event inside synchronous discovery suppresses its result or error", async (t) => {
  const { pi, ctx, ui, notifications } = interaction(t);
  for (const fail of [false, true]) {
    await showSubagentBrowser(pi.api, ctx, () => {
      pi.events.emit("permissions:ui_prompt", {});
      if (fail) throw new Error("discovery failed after cancellation");
      return content();
    });
    assert.equal(ui.interactions.length, 0);
    assertReleased(pi);
  }
  assert.deepEqual(notifications, []);
});

test("permission events before the factory or before mounting cannot leave a late overlay", async (t) => {
  for (const hook of ["beforeFactory", "beforeMount"] as const) {
    const { pi, ctx, ui } = interaction(t);
    ui[hook] = () => pi.events.emit("permissions:ui_prompt", {});
    await showSubagentBrowser(pi.api, ctx, () => content());
    await flushPromises();
    assert.equal(ui.interactions.length, 1);
    assert.equal(ui.interactions[0].closed, true);
    assert.equal(ui.interactions[0].mounted, false);
    assert.equal(ui.interactions[0].doneCalls, 1);
    assertReleased(pi);
  }
});

test("shutdown during synchronous discovery or a mounted dialog prevents further UI work", async (t) => {
  for (const mounted of [false, true]) {
    const { pi, ctx, ui, notifications } = interaction(t);
    let shutdown: Promise<unknown[]> | undefined;
    const opening = showSubagentBrowser(pi.api, ctx, () => {
      if (!mounted) shutdown = pi.emitLifecycle("session_shutdown", ctx);
      return content();
    });
    if (mounted) {
      await flushPromises();
      shutdown = pi.emitLifecycle("session_shutdown", ctx);
      assert.equal(ui.interactions[0].closed, true);
    }
    await shutdown;
    await opening;
    await flushPromises();
    assert.equal(ui.interactions.length, mounted ? 1 : 0);
    assert.deepEqual(notifications, []);
    assertReleased(pi);
  }
});

test("Ctrl+C closes both screens and user cancellation releases the interaction", async (t) => {
  const { pi, ctx, ui } = interaction(t);
  for (const detail of [false, true]) {
    const opening = showSubagentBrowser(pi.api, ctx, () => content());
    await flushPromises();
    const current = ui.interactions.at(-1)!;
    if (detail) current.component!.handleInput!(keys.enter);
    current.component!.handleInput!(keys.ctrlC);
    await opening;
    assert.equal(current.doneCalls, 1);
    assertReleased(pi);
  }
});

test("empty lists and loading or custom-UI failures notify and release listeners", async (t) => {
  const { pi, ctx, ui, notifications } = interaction(t);
  await showSubagentBrowser(pi.api, ctx, () => content(0));
  assert.equal(ui.interactions.length, 0);
  assert.deepEqual(notifications.pop(), { message: "No test items.", type: "info" });
  assertReleased(pi);
  await showSubagentBrowser(pi.api, ctx, () => { throw new Error("discovery failed"); });
  assert.match(notifications.at(-1)!.message, /discovery failed/);
  assert.equal(notifications.at(-1)!.type, "error");
  assertReleased(pi);
  ctx.ui.custom = async () => { throw new Error("UI unavailable"); };
  await showSubagentBrowser(pi.api, ctx, () => content());
  assert.match(notifications.at(-1)!.message, /UI unavailable/);
  assertReleased(pi);
});
