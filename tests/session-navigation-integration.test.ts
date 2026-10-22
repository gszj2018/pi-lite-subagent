/** Fake runtime replacement over isolated temp files; no real Pi, models, terminal or process.env. */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { type ExtensionCommandContext, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerActiveAgentMarker } from "../extension/active-agent.ts";
import { PARENT_SESSION_ENV, registerSessionEnv } from "../extension/env-vars.ts";
import { registerSessionNavigation } from "../extension/session-navigation.ts";
import { registerSubagentCommands } from "../extension/subagent-commands.ts";
import { MAX_SESSION_METADATA_BYTES, validateSessionFile } from "../extension/subagent-sessions.ts";
import type { NavigationState, ProcessEnvLike } from "../extension/types.ts";
import { agentMarkdown, writeAgentFile } from "./helpers/agents-fixture.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { type ContextOptions, createContext, flushPromises, MockPi } from "./helpers/mocks.ts";
import { sessionText, withTempSessions } from "./helpers/sessions-fixture.ts";

interface Runtime {
  pi: MockPi;
  ui: BrowserUI;
  ctx: ExtensionCommandContext;
  options: ContextOptions;
  notifications: { message: string; type?: string }[];
  alive: boolean;
}

async function fixture(t: TestContext) {
  const files = await withTempSessions(t);
  const { agentDir, projectDir } = files;
  await writeAgentFile(path.join(agentDir, "agents"), "worker.md", agentMarkdown({ name: "worker", description: "test" }));
  await fs.mkdir(path.join(projectDir, ".pi", "agents"), { recursive: true });
  const env: ProcessEnvLike = {};
  const state: NavigationState = { frames: [] };
  const runtimes: Runtime[] = [];
  const switches: string[] = [];
  const staleAccesses: string[] = [];
  let current: Runtime;
  let switchMode: "normal" | "cancel" | "throw" = "normal";
  const makeRuntime = async (file: string, reason = "resume"): Promise<Runtime> => {
    const pi = new MockPi();
    const ui = new BrowserUI();
    ui.terminal.rows = 50;
    const entries = parseSessionEntries(await fs.readFile(file, "utf8"));
    const header = entries[0];
    assert.equal(header?.type, "session", "the fake runtime loads the current file's header");
    const options: ContextOptions = {
      cwd: projectDir, sessionId: header.id, sessionFile: file,
      sessionDir: path.dirname(file), entries,
    };
    const mock = createContext(options);
    const ctx = mock.ctx as unknown as ExtensionCommandContext;
    ctx.ui.custom = ui.custom;
    registerSessionEnv(pi.api, env);
    registerSessionNavigation(pi.api, state);
    registerActiveAgentMarker(pi.api, env, state);
    registerSubagentCommands(pi.api, { agentDir });
    const runtime = { pi, ui, ctx, options, notifications: mock.notifications, alive: true };
    runtimes.push(runtime);
    ctx.switchSession = async (file) => {
      switches.push(file);
      const gates = await pi.emitLifecycle("session_before_switch", ctx, { reason: "resume", targetSessionFile: file });
      if (gates.some((result) => (result as { cancel?: boolean } | undefined)?.cancel) || switchMode === "cancel") {
        return { cancelled: true };
      }
      if (switchMode === "throw") throw new Error("mock switch failed before teardown");
      const target = await validateSessionFile(file);
      await pi.emitLifecycle("session_shutdown", ctx, { reason: "resume", targetSessionFile: file });
      runtime.alive = false;
      const stale = () => { staleAccesses.push("stale context access"); throw new Error("stale context access"); };
      ctx.sessionManager.getSessionId = stale;
      ctx.sessionManager.getSessionFile = stale;
      ctx.sessionManager.getSessionDir = stale;
      ctx.ui.notify = stale;
      ctx.isIdle = stale;
      ctx.hasPendingMessages = stale;
      current = await makeRuntime(target);
      return { cancelled: false };
    };
    await pi.emitLifecycle("session_start", ctx, reason);
    return runtime;
  };
  current = await makeRuntime(files.parent.file, "startup");
  t.after(async () => {
    if (current.alive) await current.pi.emitLifecycle("session_shutdown", current.ctx, "quit");
    for (const runtime of runtimes) runtime.ui.cancelAll();
  });
  const invoke = (name = "switch-to-subagent-session") => current.pi.commands.get(name)!.handler("", current.ctx);
  // Return a promise in a plain object so async open() does not await the still-open interaction itself.
  const openPicker = async () => {
    const ui = current.ui;
    const mounted = new Promise<void>((resolve) => { ui.beforeMount = resolve; });
    const execution = invoke();
    await Promise.race([mounted, execution.then(() => { throw new Error("Expected a session selector."); })]);
    await flushPromises();
    return { execution };
  };
  return {
    ...files, env, state, switches, staleAccesses, runtimes, invoke, openPicker,
    get current() { return current; },
    setSwitchMode: (mode: typeof switchMode) => { switchMode = mode; },
    press: (key: string) => current.ui.interactions.at(-1)!.component!.handleInput!(key),
    render: (width = 120) => current.ui.interactions.at(-1)!.component!.render(width).map(stripTerminalSequences).join("\n"),
  };
}

test("integration: parent -> external child -> parent uses real paths and protects markerless sessions", async (t) => {
  const f = await fixture(t);
  const child = await f.child();
  const directory = path.dirname(child.file);
  const external = path.join(f.projectDir, "external-sessions");
  await fs.rename(directory, external);
  await fs.symlink(external, directory, "junction");
  const realChild = await fs.realpath(child.file);
  const before = await fs.readFile(child.file);
  const source = f.current;
  const frames = f.state.frames;
  const { execution } = await f.openPicker();
  assert.equal(source.ui.interactions.at(-1)!.options?.overlay, false);
  assert.equal(source.pi.events.count("permissions:ui_prompt"), 0);
  assert.match(f.render(), /unknown · child.jsonl/);
  source.pi.events.emit("permissions:ui_prompt", {});
  assert.equal(source.ui.interactions.at(-1)!.closed, false, "inline selection does not subscribe to permission prompts");
  f.press("\r");
  await execution;
  assert.equal(source.alive, false);
  assert.equal(f.current.ctx.sessionManager.getSessionId(), child.id);
  assert.equal(f.current.ctx.sessionManager.getSessionFile(), realChild);
  assert.equal(f.state.frames, frames);
  assert.deepEqual(f.state, { frames: [f.parent.file] });
  assert.equal(f.env[PARENT_SESSION_ENV], child.id);
  assert.deepEqual(await f.current.pi.emitLifecycle("input", f.current.ctx, { text: "blocked" }), [{ action: "handled" }]);
  await f.invoke("return-to-parent-session");
  assert.equal(f.current.ctx.sessionManager.getSessionId(), f.parent.id);
  assert.equal(f.state.frames, frames);
  assert.deepEqual(f.state, { frames: [] });
  assert.equal(f.env[PARENT_SESSION_ENV], f.parent.id);
  assert.deepEqual(await f.current.pi.emitLifecycle("input", f.current.ctx, { text: "allowed" }), [undefined]);
  assert.deepEqual(await fs.readFile(child.file), before, "navigation never adds a marker or rewrites a header");
  assert.deepEqual(f.switches, [realChild, f.parent.file]);
  assert.deepEqual(f.staleAccesses, []);
});

test("integration: synthetic nested inspection stays read-only at intermediate levels and respects markers", async (t) => {
  const f = await fixture(t);
  const child = await f.child(f.parent, "child", { agent: "worker" });
  const grandchild = await f.child(child, "grandchild");
  const first = await f.openPicker();
  f.press("\r"); await first.execution;
  const second = await f.openPicker();
  f.press("\r"); await second.execution;
  assert.equal(f.current.ctx.sessionManager.getSessionId(), grandchild.id);
  assert.equal(f.state.frames.length, 2);
  await f.invoke("return-to-parent-session");
  assert.equal(f.state.frames.length, 1);
  assert.deepEqual(await f.current.pi.emitLifecycle("input", f.current.ctx, { text: "blocked" }), [{ action: "handled" }]);
  await f.invoke("return-to-parent-session");
  assert.deepEqual(f.state, { frames: [] });
  assert.deepEqual(await f.current.pi.emitLifecycle("input", f.current.ctx, { text: "allowed" }), [undefined]);
  assert.ok(f.runtimes.every((runtime) => runtime.pi.appendedEntries.length === 0));
});

test("integration: cancellation, errors and other extensions' cancellation preserve the committed stack", async (t) => {
  const f = await fixture(t);
  await f.child();
  const cancelled = await f.openPicker();
  f.press("\x1b"); await cancelled.execution;
  assert.deepEqual(f.state, { frames: [] });
  assert.equal(f.switches.length, 0);
  for (const mode of ["cancel", "throw"] as const) {
    f.setSwitchMode(mode);
    const opening = await f.openPicker();
    f.press("\r"); await opening.execution;
    assert.deepEqual(f.state, { frames: [] });
    assert.equal(f.current.alive, true);
  }
  f.setSwitchMode("normal");
  const opening = await f.openPicker();
  f.press("\r"); await opening.execution;
  const before = structuredClone(f.state);
  const off = f.current.pi.api.on("session_before_switch", () => ({ cancel: true }));
  await f.invoke("return-to-parent-session");
  assert.deepEqual(f.state, before);
  off();
  await f.invoke("return-to-parent-session");
  assert.deepEqual(f.state, { frames: [] });
});

test("integration: selected-file deletion, invalid headers and changed ids fail before switching", async (t) => {
  const f = await fixture(t);
  const child = await f.child();
  for (const content of [undefined, "bad header\n", sessionText("../unsafe", f.projectDir),
    sessionText("changed-id", f.projectDir)]) {
    await fs.writeFile(child.file, sessionText(child.id, f.projectDir));
    const opening = await f.openPicker();
    if (content === undefined) await fs.unlink(child.file);
    else await fs.writeFile(child.file, content);
    f.press("\r"); await opening.execution;
    assert.deepEqual(f.state, { frames: [] });
    assert.equal(f.switches.length, 0);
    assert.equal(f.current.notifications.at(-1)?.type, "error");
  }
});

test("integration: missing or invalid parent files retain the return frame for retry", async (t) => {
  const f = await fixture(t);
  await f.child();
  const opening = await f.openPicker();
  f.press("\r"); await opening.execution;
  const before = structuredClone(f.state);
  const parentText = await fs.readFile(f.parent.file);
  for (const content of [undefined, "bad header\n", sessionText("../unsafe", f.projectDir)]) {
    if (content === undefined) await fs.unlink(f.parent.file);
    else await fs.writeFile(f.parent.file, content);
    await f.invoke("return-to-parent-session");
    assert.deepEqual(f.state, before);
    assert.equal(f.current.notifications.at(-1)?.type, "error");
  }
  await fs.writeFile(f.parent.file, parentText);
  await f.invoke("return-to-parent-session");
  assert.deepEqual(f.state, { frames: [] });
});

test("integration: navigation gates reject non-TUI, busy, pending, empty and ephemeral cases", async (t) => {
  const f = await fixture(t);
  const ctx = f.current.ctx;
  for (const mode of ["rpc", "json", "print"] as const) {
    ctx.mode = mode;
    await f.invoke(); await f.invoke("return-to-parent-session");
  }
  ctx.mode = "tui";
  f.current.options.idle = false;
  await f.invoke(); await f.invoke("return-to-parent-session");
  f.current.options.idle = true;
  f.current.options.pendingMessages = true;
  await f.invoke();
  f.current.options.pendingMessages = false;
  await f.invoke("return-to-parent-session");
  f.current.options.sessionFile = undefined;
  await f.invoke();
  f.current.options.sessionFile = f.parent.file;
  await f.invoke(); // Missing child directory.
  await fs.mkdir(path.join(f.sessionDir, "lite-subagent", f.parent.id), { recursive: true });
  await f.invoke(); // Empty child directory.
  assert.equal(f.current.ui.interactions.length, 0);
  assert.equal(f.switches.length, 0);
  assert.ok(f.current.notifications.every((notice) => notice.type === "error"));
});

test("integration: idle/pending and the source path are rechecked after scan and selection", async (t) => {
  const f = await fixture(t);
  await f.child();
  const runtime = f.current;
  const original = runtime.ctx.sessionManager.getSessionDir;
  runtime.ctx.sessionManager.getSessionDir = () => { runtime.options.idle = false; return original(); };
  await f.invoke();
  assert.equal(runtime.ui.interactions.length, 0);
  runtime.ctx.sessionManager.getSessionDir = original;
  runtime.options.idle = true;
  const opening = await f.openPicker();
  runtime.options.pendingMessages = true;
  f.press("\r"); await opening.execution;
  assert.equal(f.switches.length, 0);
  runtime.options.pendingMessages = false;
  const next = await f.openPicker();
  runtime.options.sessionFile = path.join(f.sessionDir, "different-session.jsonl");
  f.press("\r"); await next.execution;
  assert.equal(f.switches.length, 0);
  runtime.options.sessionFile = f.parent.file;
  const validation = await f.openPicker();
  let idleChecks = 0;
  runtime.ctx.isIdle = () => ++idleChecks < 2;
  f.press("\r"); await validation.execution;
  assert.equal(f.switches.length, 0, "idle is checked again after asynchronous target-file validation");
  runtime.ctx.isIdle = () => true;
  runtime.ctx.sessionManager.getSessionDir = () => {
    runtime.options.sessionFile = path.join(f.sessionDir, "changed-during-scan.jsonl");
    return original();
  };
  await f.invoke();
  assert.equal(runtime.ui.interactions.length, 3, "a changed source never opens a late selector");
});

test("integration: shutdown during scan or selection prevents late UI and releases interaction handlers", async (t) => {
  const f = await fixture(t);
  await f.child();
  const runtime = f.current;
  const original = runtime.ctx.sessionManager.getSessionDir;
  let shutdown: Promise<unknown[]> | undefined;
  runtime.ctx.sessionManager.getSessionDir = () => {
    shutdown = runtime.pi.emitLifecycle("session_shutdown", runtime.ctx, "reload");
    return original();
  };
  await f.invoke(); await shutdown;
  assert.equal(runtime.ui.interactions.length, 0);
  runtime.ctx.sessionManager.getSessionDir = original;
  await runtime.pi.emitLifecycle("session_start", runtime.ctx, "reload");
  const baseline = runtime.pi.count("session_shutdown");
  const opening = await f.openPicker();
  await runtime.pi.emitLifecycle("session_shutdown", runtime.ctx, "reload");
  await opening.execution;
  assert.equal(runtime.ui.interactions.at(-1)!.closed, true);
  assert.equal(runtime.pi.count("session_shutdown"), baseline);
  assert.equal(f.switches.length, 0);
  assert.equal(runtime.pi.events.count("permissions:ui_prompt"), 0);
});

test("integration: browser and navigation guards are independent but each module rejects overlapping commands", async (t) => {
  const f = await fixture(t);
  await f.child();
  const opening = await f.openPicker();
  const runtime = f.current;
  const picker = runtime.ui.interactions[0];
  await f.invoke(); await f.invoke("return-to-parent-session");
  assert.equal(runtime.ui.interactions.length, 1, "navigation commands share only their module's guard");
  const browsing = f.invoke("list-subagents");
  await flushPromises();
  const browser = runtime.ui.interactions[1];
  assert.equal(browser.options?.overlay, true);
  assert.equal(picker.closed, false, "opening a browser does not cancel session selection");
  assert.equal(browser.closed, false);
  await f.invoke("view-subagents");
  assert.equal(runtime.ui.interactions.length, 2, "the second browser remains blocked within its own module");
  assert.equal(runtime.notifications.filter((notice) => notice.type === "error").length, 3);
  browser.component!.handleInput!("\x1b"); await browsing;
  assert.equal(picker.closed, false, "closing a browser does not release or close navigation");
  picker.component!.handleInput!("\x1b"); await opening.execution;
  const reopened = await f.openPicker();
  f.press("\x03"); await reopened.execution;
});

test("integration: navigation can start while browsing and switching closes the old browser on shutdown", async (t) => {
  const f = await fixture(t);
  const child = await f.child();
  const source = f.current;
  const browsing = f.invoke("list-subagents");
  await flushPromises();
  const browser = source.ui.interactions[0];
  const opening = await f.openPicker();
  assert.equal(source.ui.interactions.length, 2);
  assert.equal(browser.closed, false);
  f.press("\r"); await opening.execution;
  await browsing;
  assert.equal(browser.closed, true);
  assert.equal(browser.doneCalls, 1);
  assert.equal(source.alive, false);
  assert.equal(f.current.ctx.sessionManager.getSessionId(), child.id);
  assert.deepEqual(f.staleAccesses, []);
});

test("integration: an existing marker remains read-only after the outermost return clears the stack", async (t) => {
  const f = await fixture(t);
  await f.child();
  await fs.writeFile(f.parent.file, sessionText(f.parent.id, f.projectDir, { agent: "existing-marker" }));
  const opening = await f.openPicker();
  f.press("\r"); await opening.execution;
  await f.invoke("return-to-parent-session");
  assert.deepEqual(f.state, { frames: [] });
  assert.deepEqual(await f.current.pi.emitLifecycle("input", f.current.ctx, { text: "still blocked" }), [{ action: "handled" }]);
});

test("integration: a session growing past the metadata limit after selection remains openable", async (t) => {
  const f = await fixture(t);
  const child = await f.child();
  const opening = await f.openPicker();
  const handle = await fs.open(child.file, "r+");
  try { await handle.truncate(MAX_SESSION_METADATA_BYTES + 1); } finally { await handle.close(); }
  f.press("\r"); await opening.execution;
  assert.equal(f.current.ctx.sessionManager.getSessionId(), child.id);
});

test("integration: valid large sessions remain openable with unknown metadata", async (t) => {
  const f = await fixture(t);
  const child = await f.child(f.parent, "large");
  const handle = await fs.open(child.file, "r+");
  try { await handle.truncate(MAX_SESSION_METADATA_BYTES + 1); } finally { await handle.close(); }
  const opening = await f.openPicker();
  assert.match(f.render(), /unknown · large.jsonl/);
  f.press("\r"); await opening.execution;
  assert.equal(f.current.ctx.sessionManager.getSessionId(), child.id);
});
