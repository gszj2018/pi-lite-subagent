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

/** Split only the browser's own section boundaries, never a child component's row layout. */
function sections(lines: string[]): string[][] {
  const groups: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith("├")) groups.push([]);
    else if (line.startsWith("│")) groups.at(-1)!.push(line);
  }
  return groups;
}

function hintText(rows: string[]): string {
  return rows.map((line) => line.replace(/^│|│$/g, "").replace(/\d+–\d+\/\d+/g, "").trim()).join(" ");
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

test("native list scroll information is preserved between a separate title and footer", () => {
  const ui = new BrowserUI();
  ui.terminal.rows = 15;
  let closes = 0;
  const browser = new SubagentBrowser(content(), ui.tui, ui.theme, ui.keybindings, () => { closes++; });
  const initial = plain(browser);
  const [title, list, help] = sections(initial);
  assert.match(initial[0], /^┌─+┐$/);
  assert.match(initial.at(-1)!, /^└─+┘$/);
  assert.doesNotMatch(initial.join("\n"), /[╭╮╰╯]/);
  assert.match(title[0], /user \+ project/);
  assert.doesNotMatch(title[0], /1\/12|Esc:/);
  assert.match(list.at(-1)!, /\(1\/12\)/, "SelectList's own information row remains visible");
  assert.match(help.join("\n"), /navigate.*Enter: view.*Esc: close.*Ctrl\+C: close/);
  assert.doesNotMatch(list.join("\n"), /line-1|navigate|Esc:/);
  assert.equal(initial.length, 12, "the complete list and fixed regions fit the overlay height");
  const pageSize = list.filter((line) => line.includes("agent-")).length;
  browser.handleInput(keys.pageDown);
  const selectedList = plain(browser);
  assert.ok(selectedList.join("\n").includes(`(${pageSize + 1}/12)`));
  browser.handleInput(keys.enter);
  const detail = sections(plain(browser));
  assert.deepEqual(detail[0], title);
  assert.ok(detail[1][0].includes(`agent-${pageSize}`));
  assert.match(detail[2][0], /line-1\s/);
  assert.match(detail[3].join("\n"), /Esc: back.*Ctrl\+C: close/);
  browser.handleInput(keys.down);
  assert.deepEqual(sections(plain(browser))[1], detail[1], "detail arrows never select another item");
  browser.handleInput(keys.escape);
  assert.deepEqual(plain(browser), selectedList, "selection and centered list range are preserved");
  browser.handleInput(keys.escape);
  assert.equal(closes, 1);
});

test("a short list keeps a blank information slot and narrow footers wrap without losing help", () => {
  const ui = new BrowserUI();
  ui.terminal.rows = 40;
  const browser = new SubagentBrowser(content(2), ui.tui, ui.theme, ui.keybindings, () => {});
  const [title, list, help] = sections(plain(browser, 40));
  assert.match(title[0], /Test browser/);
  assert.equal(list.length, 3, "two options plus one reserved information row");
  assert.match(list.at(-1)!, /^│\s*│$/);
  assert.doesNotMatch(list.join("\n"), /\(\d+\/\d+\)/);
  assert.ok(help.length > 1, "the help region wraps rather than clipping its final keys");
  const helpText = help.map((line) => line.replace(/^│|│$/g, "").trim()).join(" ");
  assert.match(helpText, /Ctrl\+C: close/);
  assert.match(list[0], /→ agent-0/);
  assert.match(list[1], /agent-1/);
});

test("resizing replaces the scroll information with a blank slot when all options fit", () => {
  const ui = new BrowserUI();
  ui.terminal.rows = 15;
  const browser = new SubagentBrowser(content(6), ui.tui, ui.theme, ui.keybindings, () => {});
  const scrolling = sections(plain(browser))[1];
  assert.equal(scrolling.length, 6, "five options plus the native information row");
  assert.match(scrolling.at(-1)!, /\(1\/6\)/);
  ui.terminal.rows = 17;
  const fitted = sections(plain(browser))[1];
  assert.equal(fitted.length, 7, "six options plus a blank information slot");
  assert.match(fitted.at(-1)!, /^│\s*│$/);
  assert.doesNotMatch(fitted.join("\n"), /\(\d+\/\d+\)/);
  ui.terminal.rows = 15;
  assert.deepEqual(sections(plain(browser))[1], scrolling);
});

test("details scroll and page while their title and selected row stay fixed", () => {
  const ui = new BrowserUI();
  ui.terminal.rows = 15;
  const browser = new SubagentBrowser(content(1), ui.tui, ui.theme, ui.keybindings, () => {});
  browser.handleInput(keys.enter);
  const start = plain(browser);
  const startSections = sections(start);
  const viewport = startSections[2].length;
  browser.handleInput(keys.down);
  assert.match(sections(plain(browser))[2][0], /line-2\s/);
  browser.handleInput(keys.up);
  assert.deepEqual(plain(browser), start);
  browser.handleInput(keys.pageDown);
  const page = plain(browser);
  const pageSections = sections(page);
  assert.deepEqual(pageSections[0], startSections[0]);
  assert.deepEqual(pageSections[1], startSections[1]);
  assert.equal(hintText(pageSections[3]), hintText(startSections[3]), "only the position changes in the footer");
  assert.ok(pageSections[2][0].includes(`line-${viewport + 1} `));
  browser.handleInput(keys.pageUp);
  assert.deepEqual(plain(browser), start);
  browser.handleInput(keys.end);
  assert.match(sections(plain(browser))[2].at(-1)!, /line-60\s/);
  browser.handleInput(keys.home);
  assert.deepEqual(plain(browser), start);
  browser.handleInput(keys.up);
  assert.deepEqual(plain(browser), start, "scroll offsets cannot become negative");
});

test("only detail footers show a right-aligned visible-line range that follows scrolling and resize", () => {
  const ui = new BrowserUI();
  const browser = new SubagentBrowser(content(1), ui.tui, ui.theme, ui.keybindings, () => {});
  assert.doesNotMatch(sections(plain(browser))[2].join("\n"), /\d+–\d+\/\d+/);
  browser.handleInput(keys.enter);
  const start = sections(plain(browser));
  const viewport = start[2].length;
  assert.ok(start[3].at(-1)!.endsWith(`1–${viewport}/60│`));
  assert.doesNotMatch(start[0].join("\n"), /\d+–\d+\/\d+/);
  browser.handleInput(keys.down);
  const next = sections(plain(browser));
  assert.ok(next[3].at(-1)!.endsWith(`2–${viewport + 1}/60│`));
  assert.equal(next[2].length, viewport, "changing range digits cannot change the body viewport height");
  browser.handleInput(keys.end);
  assert.match(sections(plain(browser))[3].at(-1)!, /\d+–60\/60│$/);
  ui.terminal.rows = 35;
  const resized = sections(plain(browser, 60));
  assert.ok(resized[3].length > 1);
  const first = resized[2][0].match(/line-(\d+)/)![1];
  const last = resized[2].at(-1)!.match(/line-(\d+)/)![1];
  assert.ok(resized[3].at(-1)!.endsWith(`${first}–${last}/60│`));
  assert.match(hintText(resized[3]), /Ctrl\+C: close/);
  assert.doesNotMatch(sections(plain(browser, 25))[3].join("\n"), /\d+–\d+\/\d+/,
    "very narrow footers retain help instead of the position indicator");
  browser.handleInput(keys.escape);
  assert.doesNotMatch(plain(browser).join("\n"), /\d+–\d+\/\d+/);
});

test("detail footer ranges handle an entirely visible or empty body", () => {
  for (const [text, expected] of [["one\ntwo", "1–2/2"], ["", "0–0/0"]]) {
    const ui = new BrowserUI();
    const data = content(1);
    data.items[0].createDetail = () => new Text(text, 0, 0);
    const browser = new SubagentBrowser(data, ui.tui, ui.theme, ui.keybindings, () => {});
    browser.handleInput(keys.enter);
    assert.ok(sections(plain(browser))[3].at(-1)!.endsWith(`${expected}│`));
  }
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
  assert.match(sections(plain(browser))[2].at(-1)!, /line-60\s/, "resizing clamps the body offset to its new viewport");
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
  const changedBody = changed.find((line) => line.includes("theme-sensitive body"))!;
  assert.ok(changedBody.includes("\x1b[35m"));
  assert.ok(!changedBody.includes("\x1b[36m"));
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
  assert.match(sections(plain(browser))[1][0], /→ agent-0/);
  assert.match(sections(plain(browser))[2].join("\n"), /↑\/j: navigate.*Space: view/);
  browser.handleInput("j");
  browser.handleInput(" ");
  assert.match(sections(plain(browser))[1][0], /agent-1/);
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

test("content refresh preserves selected identity and body scroll, even when newer calls are prepended", () => {
  const ui = new BrowserUI();
  const data = content(2);
  const browser = new SubagentBrowser(data, ui.tui, ui.theme, ui.keybindings, () => {});
  browser.handleInput(keys.down);
  browser.handleInput(keys.enter);
  plain(browser);
  for (let i = 0; i < 3; i++) browser.handleInput(keys.down);
  const before = sections(plain(browser));
  const next = content(3);
  next.items = [next.items[2], data.items[0], {
    ...data.items[1], label: "updated selected task",
    createDetail: () => new Text(Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n"), 0, 0),
  }];
  browser.updateContent(next);
  const after = sections(plain(browser));
  assert.match(after[1][0], /updated selected task/);
  assert.equal(after[2][0], before[2][0], "refresh never auto-scrolls to the newest output");
  assert.match(after[3].at(-1)!, /\/80│$/);
  browser.updateContent({ ...data, items: [data.items[0]] });
  assert.match(sections(plain(browser))[1][0], /→ agent-0/);
  assert.doesNotMatch(plain(browser).join("\n"), /line-4/);
  browser.dispose();
  const requests = ui.renderRequests;
  browser.updateContent(data);
  assert.equal(ui.renderRequests, requests);
});

test("live subscriptions refresh before mounting and are detached on permission preemption", async (t) => {
  const { pi, ctx, ui } = interaction(t);
  let current = content(1);
  let refresh!: () => void;
  let loads = 0;
  let detached = 0;
  ui.beforeFactory = () => {
    current = { ...current, title: "Refreshed before mounting" };
    refresh();
  };
  const opening = showSubagentBrowser(pi.api, ctx, () => { loads++; return current; }, (listener) => {
    refresh = listener;
    return () => { detached++; };
  });
  await flushPromises();
  assert.match(plain(ui.interactions[0].component!).join("\n"), /Refreshed before mounting/);
  current = { ...current, title: "Refreshed while open" };
  refresh();
  assert.match(plain(ui.interactions[0].component!).join("\n"), /Refreshed while open/);
  pi.events.emit("permissions:ui_prompt", {});
  assert.equal(detached, 1);
  const before = loads;
  refresh();
  assert.equal(loads, before, "late callbacks cannot read a stale context or reopen the dialog");
  await opening;
  assertReleased(pi);
});

test("empty or failed refresh closes cleanly, including immediate cancellation while subscribing", async (t) => {
  for (const failure of [false, true]) {
    const { pi, ctx, notifications } = interaction(t);
    let refresh!: () => void;
    let update = false;
    let detached = 0;
    const opening = showSubagentBrowser(pi.api, ctx, () => {
      if (update && failure) throw new Error("refresh failed");
      return content(update ? 0 : 1);
    }, (listener) => { refresh = listener; return () => { detached++; }; });
    update = true;
    refresh();
    await opening;
    assert.equal(detached, 1);
    assert.equal(notifications.length, failure ? 1 : 0);
    assertReleased(pi);
  }
  const { pi, ctx, ui } = interaction(t);
  let detached = 0;
  await showSubagentBrowser(pi.api, ctx, () => content(1), () => {
    pi.events.emit("permissions:ui_prompt", {});
    return () => { detached++; };
  });
  assert.equal(detached, 1);
  assert.equal(ui.interactions.length, 0);
  assertReleased(pi);
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
