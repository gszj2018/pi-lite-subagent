/**
 * Full-lifecycle integration tests: environment bookkeeping, depth gating and
 * the active_agent marker assembled the same way the factory assembles them.
 */

import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { ACTIVE_AGENT_ENTRY_TYPE, registerActiveAgentMarker } from "../extension/active-agent.ts";
import {
  DEPTH_ENV,
  NAME_ENV,
  PARENT_SESSION_ENV,
  isSubagentToolAllowed,
  registerSessionEnv,
} from "../extension/env-vars.ts";
import { registerSubagentTool } from "../extension/subagent-tool.ts";
import { registerSessionNavigation } from "../extension/session-navigation.ts";
import type { ProcessEnvLike } from "../extension/types.ts";
import { withTempUserAgents } from "./helpers/agents-fixture.ts";
import { MockSpawn } from "./helpers/mock-spawn.ts";
import { MockPi, createContext } from "./helpers/mocks.ts";

/** Assemble like the factory: session env and marker always, the tool only when the depth gate allows. */
async function setupExtension(t: TestContext, pi: MockPi, env: ProcessEnvLike) {
  const spawnMock = new MockSpawn([]);
  const { agentDir, projectDir } = await withTempUserAgents(t);
  registerSessionEnv(pi.api, env);
  registerSessionNavigation(pi.api, env);
  registerActiveAgentMarker(pi.api, env);
  if (isSubagentToolAllowed(env)) {
    registerSubagentTool(pi.api, {
      spawn: spawnMock.spawn,
      env,
      agentDir,
      piLaunch: { execPath: "/fake/bin/pi-runtime" },
      extensionArgs: { extensions: [], noExtensions: false },
    });
  }
  return { spawnMock, projectDir };
}

test("integration: root session lifecycle writes and cleans the parent session pointer", async (t) => {
  const env: ProcessEnvLike = {};
  const pi = new MockPi();
  const { projectDir } = await setupExtension(t, pi, env);
  assert.ok(pi.tools.has("subagent"), "root sessions register the subagent tool");

  const { ctx } = createContext({ cwd: projectDir, sessionId: "root-1" });
  await pi.emitLifecycle("session_start", ctx);
  assert.equal(env[PARENT_SESSION_ENV], "root-1");

  await pi.emitLifecycle("session_shutdown", ctx);
  assert.equal(env[PARENT_SESSION_ENV], undefined);
});

test("integration: subagent session stays a leaf, keeps env and becomes inspection-only", async (t) => {
  const env: ProcessEnvLike = {
    [DEPTH_ENV]: "1",
    [NAME_ENV]: "worker",
    [PARENT_SESSION_ENV]: "root-1",
  };
  const pi = new MockPi();
  const { projectDir } = await setupExtension(t, pi, env);
  assert.equal(pi.tools.has("subagent"), false, "subagent sessions never register the tool");

  const { ctx, notifications } = createContext({ cwd: projectDir, sessionId: "child-1", entries: [] });
  await pi.emitLifecycle("session_start", ctx);
  assert.equal(env[PARENT_SESSION_ENV], "root-1", "the inherited pointer is never overwritten");
  assert.equal(env[DEPTH_ENV], "1");
  assert.equal(env[NAME_ENV], "worker");

  // New subagent session timing: the first prompt passes, then the marker lands.
  const [before] = await pi.emitLifecycle("input", ctx, { text: "hi", source: "interactive" });
  assert.equal(before, undefined);

  await pi.emitLifecycle("before_agent_start", ctx);
  assert.deepEqual(pi.appendedEntries, [{ customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "worker" } }]);

  const [after] = await pi.emitLifecycle("input", ctx, { text: "hi", source: "interactive" });
  assert.deepEqual(after, { action: "handled" });
  assert.equal(notifications[notifications.length - 1].type, "error");
});

test("integration: a resumed subagent session keeps one marker and stays inspection-only", async (t) => {
  const env: ProcessEnvLike = {
    [DEPTH_ENV]: "1",
    [NAME_ENV]: "worker",
    [PARENT_SESSION_ENV]: "root-1",
  };
  const pi = new MockPi();
  const { projectDir } = await setupExtension(t, pi, env);

  const markerEntry = { type: "custom", customType: ACTIVE_AGENT_ENTRY_TYPE, data: { name: "worker" } };
  const { ctx } = createContext({ cwd: projectDir, sessionId: "child-1", entries: [markerEntry] });
  await pi.emitLifecycle("session_start", ctx);
  await pi.emitLifecycle("before_agent_start", ctx);
  assert.deepEqual(pi.appendedEntries, [], "the resumed session already carries the marker");

  const [blocked] = await pi.emitLifecycle("input", ctx, { text: "hi", source: "interactive" });
  assert.deepEqual(blocked, { action: "handled" });
});
