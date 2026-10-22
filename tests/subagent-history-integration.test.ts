/** History commands assembled with fake host events, a fake terminal and optionally MockSpawn. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerSubagentCommands } from "../extension/subagent-commands.ts";
import { registerSubagentTool } from "../extension/subagent-tool.ts";
import { withTempUserAgents } from "./helpers/agents-fixture.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { callEntry, resultEntry, singleResult, task } from "./helpers/history-fixture.ts";
import { assistantMessage, messageEndEvent, MockSpawn } from "./helpers/mock-spawn.ts";
import { createContext, flushPromises, MockPi } from "./helpers/mocks.ts";

async function setup(t: TestContext, branch: unknown[], mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const { agentDir } = await withTempUserAgents(t);
  await fs.promises.mkdir(path.join(agentDir, ".pi", "agents"), { recursive: true });
  const pi = new MockPi();
  const ui = new BrowserUI();
  ui.terminal.rows = 50;
  const mock = createContext({
    branch, entries: [callEntry("abandoned", [task("hidden-agent", "hidden history")])],
    cwd: agentDir, idle: false, pendingMessages: true, mode,
  });
  const ctx = mock.ctx as unknown as ExtensionCommandContext;
  ctx.ui.custom = ui.custom;
  registerSubagentCommands(pi.api, { agentDir });
  t.after(async () => {
    await pi.emitLifecycle("session_shutdown", ctx);
    ui.cancelAll();
  });
  const invoke = (name = "view-subagents") => pi.commands.get(name)!.handler("", ctx);
  const press = (key: string) => ui.interactions.at(-1)!.component!.handleInput!(key);
  const render = () => ui.interactions.at(-1)!.component!.render(160).map(stripTerminalSequences).join("\n");
  return { pi, ctx, ui, invoke, press, render, agentDir, notifications: mock.notifications };
}

test("integration: view-subagents lists only active-branch tasks in recent-call order and renders original/executed tasks", async (t) => {
  const branch = [
    callEntry("old", [task("worker", "old task")]),
    resultEntry("old", [singleResult({ task: "old task" })]),
    callEntry("new", [task("worker", "produce"), task("worker", "consume {previous}\nfollow up")], "chain"),
    resultEntry("new", [
      singleResult({ task: "produce", step: 1 }),
      singleResult({ task: "consume actual answer\nfollow up", step: 2, model: "provider/model" }),
    ], { mode: "chain" }),
  ];
  const f = await setup(t, branch);
  const opening = f.invoke();
  await flushPromises();
  const list = f.render();
  assert.ok(list.indexOf("worker · produce") < list.indexOf("worker · consume"));
  assert.ok(list.indexOf("worker · consume") < list.indexOf("worker · old task"));
  assert.doesNotMatch(list, /\{previous\}|hidden-agent|hidden history/);
  f.press("\x1b[B");
  f.press("\r");
  const detail = f.render();
  assert.match(detail, /Status: Completed/);
  assert.match(detail, /Task: consume \{previous\}/);
  assert.match(detail, /Executed task: consume actual answer/);
  assert.match(detail, /Mode: chain · Step 2/);
  assert.match(detail, /Model: provider\/model/);
  assert.match(detail, /1 turn/);
  f.press("\x03");
  await opening;
});

test("integration: parallel execution updates the selected task live and reconciles persisted results", async (t) => {
  const tasks = [task("worker", "first"), task("worker", "second")];
  const branch: unknown[] = [callEntry("live", tasks)];
  const f = await setup(t, branch);
  const spawnMock = new MockSpawn([
    { hold: true, stdoutLines: [messageEndEvent(assistantMessage("first output"))] },
    { hold: true, stdoutLines: [messageEndEvent(assistantMessage("second output"))] },
  ]);
  t.after(() => { for (const proc of spawnMock.procs) proc.release(); });
  registerSubagentTool(f.pi.api, {
    agentDir: f.agentDir, spawn: spawnMock.spawn, env: {}, piLaunch: { execPath: "/fake/pi" },
    extensionArgs: { extensions: [], noExtensions: false },
  });
  const event = { toolName: "subagent", toolCallId: "live" };
  await f.pi.emitLifecycle("tool_execution_start", f.ctx, event);
  const updates: Promise<unknown>[] = [];
  const execution = f.pi.tools.get("subagent").execute("live", { tasks }, undefined, (partial: unknown) => {
    updates.push(f.pi.emitLifecycle("tool_execution_update", f.ctx, { ...event, partialResult: partial }));
  }, f.ctx);
  const opening = f.invoke();
  await flushPromises();
  f.press("\x1b[B");
  f.press("\r");
  assert.match(f.render(), /Status: Pending \/ running/);
  spawnMock.procs[0].release();
  await flushPromises();
  assert.match(f.render(), /worker · second/);
  assert.doesNotMatch(f.render(), /first output/);
  spawnMock.procs[1].release();
  const final = await execution;
  await Promise.all(updates);
  await f.pi.emitLifecycle("tool_execution_end", f.ctx, { ...event, result: final, isError: false });
  assert.match(f.render(), /Status: Completed/);
  assert.match(f.render(), /second output/);
  assert.doesNotMatch(f.render(), /first output/);
  const persisted = resultEntry("live", [], { details: final.details, text: final.content[0].text });
  await f.pi.emitLifecycle("message_end", f.ctx, { message: persisted.message });
  branch.push(persisted);
  await f.pi.emitLifecycle("turn_end", f.ctx);
  assert.match(f.render(), /Status: Completed/);
  f.press("\x03");
  await opening;
  const requests = f.ui.renderRequests;
  await f.pi.emitLifecycle("turn_end", f.ctx);
  assert.equal(f.ui.renderRequests, requests, "closing removes the live UI subscriber");
  assert.equal(f.pi.events.count("permissions:ui_prompt"), 0);
});

test("integration: failed chain steps expose stderr and all later task slots remain available as skipped", async (t) => {
  const tasks = [task(), task("worker", "later"), task("worker", "last")];
  const f = await setup(t, [
    callEntry("c", tasks, "chain"),
    resultEntry("c", [singleResult({ step: 1, exitCode: 1, messages: [], stderr: "child process failed" })], {
      mode: "chain", isError: true, text: "chain stopped",
    }),
  ]);
  const opening = f.invoke();
  await flushPromises();
  assert.match(f.render(), /worker · last/);
  f.press("\r");
  assert.match(f.render(), /Status: Failed/);
  assert.match(f.render(), /Stderr: child process failed/);
  f.press("\x1b");
  f.press("\x1b[B");
  f.press("\x1b[B");
  f.press("\r");
  assert.match(f.render(), /Status: Skipped/);
  assert.match(f.render(), /chain stopped/);
  f.press("\x03");
  await opening;
});

test("integration: missing result details retain the call's error text without pretending it is running", async (t) => {
  const f = await setup(t, [callEntry("c"), resultEntry("c", [], { details: undefined, isError: true, text: "tool unavailable" })]);
  const opening = f.invoke();
  await flushPromises();
  f.press("\r");
  assert.match(f.render(), /Result details unavailable/);
  assert.match(f.render(), /tool unavailable/);
  assert.doesNotMatch(f.render(), /Status: Pending/);
  f.press("\x03");
  await opening;
});

test("integration: browsers share mutual exclusion and permission preemption prevents late live refresh", async (t) => {
  const f = await setup(t, [callEntry("c")]);
  const opening = f.invoke();
  await flushPromises();
  await f.invoke("list-subagents");
  assert.deepEqual(f.notifications.pop(), { message: "A subagent browser is already open.", type: "error" });
  const current = f.ui.interactions[0];
  f.pi.events.emit("permissions:ui_prompt", { forwarding: { requesterAgentName: "worker" } });
  assert.equal(current.closed, true);
  const requests = f.ui.renderRequests;
  await f.pi.emitLifecycle("tool_execution_start", f.ctx, { toolName: "subagent", toolCallId: "c" });
  assert.equal(f.ui.renderRequests, requests);
  await opening;
  assert.equal(f.pi.events.count("permissions:ui_prompt"), 0);
});

test("integration: branch navigation to no subagent calls closes the view without an empty overlay", async (t) => {
  const branch: unknown[] = [callEntry("c")];
  const f = await setup(t, branch);
  const opening = f.invoke();
  await flushPromises();
  branch.length = 0;
  await f.pi.emitLifecycle("session_tree", f.ctx);
  await opening;
  assert.equal(f.ui.interactions.length, 1);
  assert.equal(f.ui.interactions[0].closed, true);
  assert.deepEqual(f.notifications, []);
});

test("integration: view-subagents rejects non-TUI modes and notifies when the branch is empty", async (t) => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const f = await setup(t, [callEntry("c")], mode);
    await f.invoke();
    assert.equal(f.ui.interactions.length, 0);
    assert.deepEqual(f.notifications, [{ message: "view-subagents requires interactive TUI mode.", type: "error" }]);
  }
  const empty = await setup(t, []);
  await empty.invoke();
  assert.deepEqual(empty.notifications, [{ message: "No subagent calls found on the active branch.", type: "info" }]);
  assert.equal(empty.ui.interactions.length, 0);
});
