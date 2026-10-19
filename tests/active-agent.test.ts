import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE_AGENT_ENTRY_TYPE, registerActiveAgentMarker } from "../extension/active-agent.ts";
import { DEPTH_ENV, NAME_ENV } from "../extension/env-vars.ts";
import type { ProcessEnvLike } from "../extension/types.ts";
import { MockPi, createContext } from "./helpers/mocks.ts";

const markerEntry = { type: "custom", customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "worker" } };

function mockTheme() {
  return {
    bg: (_name: string, text: string) => text,
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
  };
}

test("session_start scanning sets the marker explicitly on every session", async () => {
  const pi = new MockPi();
  registerActiveAgentMarker(pi.api, {});

  // Hit: the session already carries the marker (e.g. a resumed subagent session).
  await pi.emitLifecycle("session_start", createContext({ entries: [markerEntry] }).ctx);
  const hitCtx = createContext();
  const [blocked] = await pi.emitLifecycle("input", hitCtx.ctx, { text: "hi", source: "interactive" });
  assert.deepEqual(blocked, { action: "handled" }, "marker sessions block prompts");
  assert.equal(hitCtx.notifications.length, 1);
  assert.equal(hitCtx.notifications[0].type, "error");

  // Miss: an entry-less session explicitly clears the flag.
  await pi.emitLifecycle("session_start", createContext({ entries: [{ type: "message" }] }).ctx);
  const [passed] = await pi.emitLifecycle("input", createContext().ctx, { text: "hi", source: "interactive" });
  assert.equal(passed, undefined, "ordinary sessions pass prompts");

  // Switching between sessions never leaks the old value.
  await pi.emitLifecycle("session_start", createContext({ entries: [markerEntry] }).ctx);
  await pi.emitLifecycle("session_start", createContext({ entries: [] }).ctx);
  const [afterSwitch] = await pi.emitLifecycle("input", createContext().ctx, { text: "hi", source: "interactive" });
  assert.equal(afterSwitch, undefined, "switching to an entry-less session resets the marker");
});

test("before_agent_start appends the marker only in subagent sessions and only once", async () => {
  const subagentEnv: ProcessEnvLike = { [DEPTH_ENV]: "1", [NAME_ENV]: "worker" };

  // Non-subagent session: nothing is appended.
  const root = new MockPi();
  registerActiveAgentMarker(root.api, {});
  await root.emitLifecycle("session_start", createContext({ entries: [] }).ctx);
  await root.emitLifecycle("before_agent_start", createContext().ctx);
  assert.deepEqual(root.appendedEntries, []);

  // Subagent session: appended exactly once.
  const pi = new MockPi();
  registerActiveAgentMarker(pi.api, subagentEnv);
  const { ctx } = createContext({ entries: [] });
  await pi.emitLifecycle("session_start", ctx);
  await pi.emitLifecycle("before_agent_start", ctx);
  assert.deepEqual(pi.appendedEntries, [{ customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "worker" } }]);
  await pi.emitLifecycle("before_agent_start", ctx);
  assert.equal(pi.appendedEntries.length, 1, "the marker is appended only once");

  // Resumed subagent session: the scan already found the entry, so no duplicate.
  const resumed = new MockPi();
  registerActiveAgentMarker(resumed.api, subagentEnv);
  await resumed.emitLifecycle("session_start", createContext({ entries: [markerEntry] }).ctx);
  await resumed.emitLifecycle("before_agent_start", createContext().ctx);
  assert.deepEqual(resumed.appendedEntries, []);

  // Missing name: nothing is appended.
  const unnamed = new MockPi();
  registerActiveAgentMarker(unnamed.api, { [DEPTH_ENV]: "1" });
  await unnamed.emitLifecycle("before_agent_start", createContext().ctx);
  assert.deepEqual(unnamed.appendedEntries, []);
});

test("input passes before the marker exists and is blocked afterwards", async () => {
  const pi = new MockPi();
  registerActiveAgentMarker(pi.api, { [DEPTH_ENV]: "1", [NAME_ENV]: "worker" });
  const { ctx, notifications } = createContext({ entries: [] });

  // New subagent session timing: session_start (empty) -> first prompt passes.
  await pi.emitLifecycle("session_start", ctx);
  const [before] = await pi.emitLifecycle("input", ctx, { text: "hi", source: "interactive" });
  assert.equal(before, undefined, "the first prompt passes");

  // before_agent_start appends the marker; later prompts are blocked.
  await pi.emitLifecycle("before_agent_start", ctx);
  const [after] = await pi.emitLifecycle("input", ctx, { text: "hi", source: "interactive" });
  assert.deepEqual(after, { action: "handled" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "error");
});

test("the entry renderer shows the agent name", () => {
  const pi = new MockPi();
  registerActiveAgentMarker(pi.api, {});

  const renderer = pi.entryRenderers.get(ACTIVE_AGENT_ENTRY_TYPE);
  assert.ok(renderer, "the renderer is registered unconditionally");
  const component = renderer(markerEntry, { expanded: false }, mockTheme()) as { render: (width: number) => string[] };
  const text = component.render(40).join("\n");
  assert.match(text, /Subagent session \(inspection only\)/);
  assert.match(text, /worker/);
});
