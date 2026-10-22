import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerActiveAgentMarker } from "../extension/active-agent.ts";
import { registerSubagentCommands } from "../extension/subagent-commands.ts";
import { agentMarkdown, makeTempDir, writeAgentFile } from "./helpers/agents-fixture.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { type ContextOptions, createContext, flushPromises, MockPi } from "./helpers/mocks.ts";

async function fixture(t: TestContext, options: ContextOptions = {}) {
  const tmp = await makeTempDir("pi-lite-command-");
  t.after(tmp.cleanup);
  const agentDir = path.join(tmp.dir, "agent-dir");
  const project = path.join(tmp.dir, "project");
  const projectAgents = path.join(project, ".pi", "agents");
  // Stop upward discovery inside this fixture, never in a real user's project.
  await fs.promises.mkdir(projectAgents, { recursive: true });
  await fs.promises.mkdir(path.join(agentDir, "agents"), { recursive: true });
  const pi = new MockPi();
  const ui = new BrowserUI();
  const mock = createContext({ cwd: project, ...options });
  const ctx = mock.ctx as unknown as ExtensionCommandContext;
  ctx.ui.custom = ui.custom;
  registerSubagentCommands(pi.api, { agentDir });
  t.after(() => {
    pi.events.emit("permissions:ui_prompt", {});
    ui.cancelAll();
  });
  const invoke = () => pi.commands.get("list-subagents")!.handler("", ctx);
  const userFile = (name: string) => path.join(agentDir, "agents", name);
  const render = () => ui.interactions.at(-1)!.component!.render(180).map(stripTerminalSequences).join("\n");
  const press = (key: string) => ui.interactions.at(-1)!.component!.handleInput!(key);
  return {
    pi, ui, ctx, invoke, render, press, agentDir, project, projectAgents, userFile,
    notifications: mock.notifications,
  };
}

test("list-subagents keeps same-name user and project agents, grouped in stable name order", async (t) => {
  const f = await fixture(t, { trusted: true });
  for (const name of ["zeta", "shared", "alpha"]) {
    await writeAgentFile(path.join(f.agentDir, "agents"), `${name}.md`, agentMarkdown({ name, description: `user ${name}` }));
  }
  for (const name of ["shared", "beta"]) {
    await writeAgentFile(f.projectAgents, `${name}.md`, agentMarkdown({ name, description: `project ${name}` }));
  }
  await writeAgentFile(f.projectAgents, "invalid.md", "---\nname: invalid\n---\nNot an executable definition.");
  const opening = f.invoke();
  await flushPromises();
  const list = f.render();
  assert.match(list, /Subagent definitions \[user \+ project\]/);
  const names = ["alpha (user)", "shared (user)", "zeta (user)", "beta (project)", "shared (project)"];
  for (const name of names) assert.ok(list.includes(name), name);
  assert.deepEqual(names.map((name) => list.indexOf(name)), names.map((name) => list.indexOf(name)).sort((a, b) => a - b));
  assert.doesNotMatch(list, /invalid \(project\)/, "discovery's invalid-definition filtering is preserved");
  assert.deepEqual([...f.pi.commands.keys()], ["list-subagents", "view-subagents"], "session navigation stays deferred");
  f.press("\x1b");
  await opening;
});

test("untrusted projects are omitted and both screens show the allowed discovery range", async (t) => {
  const f = await fixture(t);
  await writeAgentFile(path.join(f.agentDir, "agents"), "worker.md", agentMarkdown({ name: "worker", description: "user" }));
  await writeAgentFile(f.projectAgents, "private.md", agentMarkdown({ name: "project-private", description: "not trusted" }));
  const opening = f.invoke();
  await flushPromises();
  assert.match(f.render(), /Subagent definitions \[user only: project not trusted\]/);
  assert.doesNotMatch(f.render(), /project-private/);
  f.press("\r");
  assert.match(f.render(), /Subagent definitions \[user only: project not trusted\]/);
  assert.match(f.render(), /Scope: user/);
  assert.doesNotMatch(f.render(), /project-private/);
  f.press("\x03");
  await opening;
});

test("definition details use parsed metadata and the discovery-time body without rereading the file", async (t) => {
  const f = await fixture(t, { trusted: true });
  const original = [
    "---", "name: worker", "description: Parsed definition", "tools: [read, bash]", "model: provider/model",
    "thinking: high", "unknown: FRONTMATTER_SECRET", "---", "", "Body from the discovery snapshot.",
  ].join("\n");
  await writeAgentFile(path.join(f.agentDir, "agents"), "worker.md", original);
  const opening = f.invoke();
  await flushPromises();
  // Removing the file proves selecting a definition does not perform a second read.
  await fs.promises.unlink(f.userFile("worker.md"));
  f.press("\r");
  const detail = f.render();
  for (const expected of [
    "Name: worker", "Description: Parsed definition", "Scope: user", `File: ${f.userFile("worker.md")}`,
    "Tools: read, bash", "Model: provider/model", "Thinking: high", "Body from the discovery snapshot.",
  ]) assert.ok(detail.includes(expected), expected);
  assert.doesNotMatch(detail, /FRONTMATTER_SECRET|unknown:|---|name: worker/);
  f.press("\x03");
  await opening;
});

test("undefined or invalid optional metadata does not invent dispatch-time defaults", async (t) => {
  const f = await fixture(t);
  await writeAgentFile(path.join(f.agentDir, "agents"), "worker.md", [
    "---", "name: worker", "description: Basic definition", "tools: 42", "model: [invalid]", "thinking: invalid",
    "---", "", "Plain body.",
  ].join("\n"));
  const opening = f.invoke();
  await flushPromises();
  f.press("\r");
  const detail = f.render();
  assert.match(detail, /Name: worker/);
  assert.match(detail, /Plain body/);
  assert.doesNotMatch(detail, /Tools:|Model:|Thinking:/);
  f.press("\x03");
  await opening;
});

test("scope titles do not depend on whether a trusted project's discovery returns agents", async (t) => {
  const f = await fixture(t, { trusted: true });
  await writeAgentFile(path.join(f.agentDir, "agents"), "worker.md", agentMarkdown({ name: "worker", description: "user" }));
  const opening = f.invoke();
  await flushPromises();
  assert.match(f.render(), /\[user \+ project\]/);
  f.press("\x03");
  await opening;
});

test("the command remains usable while busy and inside an inspection-only session", async (t) => {
  const f = await fixture(t, {
    idle: false,
    pendingMessages: true,
    entries: [{ type: "custom", customType: "active_agent", data: { name: "worker" } }],
  });
  await writeAgentFile(path.join(f.agentDir, "agents"), "worker.md", agentMarkdown({ name: "worker", description: "d" }));
  registerActiveAgentMarker(f.pi.api, {});
  await f.pi.emitLifecycle("session_start", f.ctx);
  const opening = f.invoke();
  await flushPromises();
  assert.equal(f.ui.interactions[0].mounted, true);
  const [blocked] = await f.pi.emitLifecycle("input", f.ctx, { text: "prompt", source: "interactive" });
  assert.deepEqual(blocked, { action: "handled" }, "commands do not disable the existing prompt guard");
  f.press("\x03");
  await opening;
});

test("non-TUI modes report an error without opening a browser or subscribing interaction handlers", async (t) => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const f = await fixture(t, { mode });
    await f.invoke();
    assert.equal(f.ui.interactions.length, 0);
    assert.deepEqual(f.notifications, [{ message: "list-subagents requires interactive TUI mode.", type: "error" }]);
    assert.equal(f.pi.events.count("permissions:ui_prompt"), 0);
    assert.equal(f.pi.count("session_shutdown"), 1, "only the session-local history observer is registered");
  }
});

test("an empty discovery notifies without opening an empty list", async (t) => {
  const f = await fixture(t);
  await f.invoke();
  assert.equal(f.ui.interactions.length, 0);
  assert.deepEqual(f.notifications, [{
    message: "No subagent definitions found [user only: project not trusted].", type: "info",
  }]);
  assert.equal(f.pi.events.count("permissions:ui_prompt"), 0);
});

test("the command rejects overlapping browsers and releases its guard after permission cancellation", async (t) => {
  const f = await fixture(t);
  await writeAgentFile(path.join(f.agentDir, "agents"), "worker.md", agentMarkdown({ name: "worker", description: "d" }));
  const first = f.invoke();
  await flushPromises();
  await f.invoke();
  assert.equal(f.ui.interactions.length, 1);
  assert.deepEqual(f.notifications.pop(), { message: "A subagent browser is already open.", type: "error" });
  f.pi.events.emit("permissions:ui_prompt", {});
  assert.equal(f.ui.interactions[0].closed, true);
  await first;
  const second = f.invoke();
  await flushPromises();
  assert.equal(f.ui.interactions.length, 2);
  f.press("\x03");
  await second;
  assert.equal(f.pi.events.count("permissions:ui_prompt"), 0);
  assert.equal(f.pi.count("session_shutdown"), 1, "closing dialogs leaves only the history lifecycle observer");
});

test("discovery errors are caught at the command boundary and do not leave a stale interaction guard", async (t) => {
  const f = await fixture(t);
  f.ctx.isProjectTrusted = () => { throw new Error("discovery context unavailable"); };
  await f.invoke();
  assert.match(f.notifications.at(-1)!.message, /discovery context unavailable/);
  assert.equal(f.notifications.at(-1)!.type, "error");
  assert.equal(f.pi.events.count("permissions:ui_prompt"), 0);
  f.ctx.isProjectTrusted = () => false;
  await f.invoke();
  assert.equal(f.notifications.at(-1)!.type, "info", "a later invocation is not rejected as already active");
});
