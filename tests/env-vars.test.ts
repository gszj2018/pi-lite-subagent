import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEPTH_ENV,
  MAX_SUBAGENT_DEPTH,
  NAME_ENV,
  PARENT_SESSION_ENV,
  buildChildEnv,
  getSubagentName,
  isSubagentSession,
  isSubagentToolAllowed,
  parseSubagentDepth,
  registerSessionEnv,
} from "../extension/env-vars.ts";
import type { ProcessEnvLike } from "../extension/types.ts";
import { MockPi, createContext } from "./helpers/mocks.ts";

test("parseSubagentDepth accepts only integer strings >= 1", () => {
  assert.equal(parseSubagentDepth(undefined), undefined);
  assert.equal(parseSubagentDepth(""), undefined);
  assert.equal(parseSubagentDepth("   "), undefined);
  assert.equal(parseSubagentDepth("0"), undefined);
  assert.equal(parseSubagentDepth(" 0 "), undefined);
  assert.equal(parseSubagentDepth("-1"), undefined);
  assert.equal(parseSubagentDepth("1.5"), undefined);
  assert.equal(parseSubagentDepth("abc"), undefined);
  assert.equal(parseSubagentDepth("1abc"), undefined);
  assert.equal(parseSubagentDepth("Infinity"), undefined);
  assert.equal(parseSubagentDepth("9007199254740993"), undefined, "beyond safe integers is invalid");

  assert.equal(parseSubagentDepth("1"), 1);
  assert.equal(parseSubagentDepth(" 2 "), 2);
  assert.equal(parseSubagentDepth("12"), 12);
});

test("isSubagentSession and isSubagentToolAllowed gate on the parsed depth", () => {
  // Parent session: absent or invalid depth.
  for (const value of [undefined, "", "0", "-1", "1.5", "junk"] as const) {
    const env: ProcessEnvLike = value === undefined ? {} : { [DEPTH_ENV]: value };
    assert.equal(isSubagentSession(env), false, String(value));
    assert.equal(isSubagentToolAllowed(env), true, String(value));
  }

  // Subagent sessions: valid depth, leaf at MAX_SUBAGENT_DEPTH.
  assert.equal(isSubagentSession({ [DEPTH_ENV]: "1" }), true);
  assert.equal(isSubagentSession({ [DEPTH_ENV]: String(MAX_SUBAGENT_DEPTH) }), true);
  assert.equal(isSubagentSession({ [DEPTH_ENV]: "2" }), true);
  assert.equal(isSubagentToolAllowed({ [DEPTH_ENV]: "1" }), false);
  assert.equal(isSubagentToolAllowed({ [DEPTH_ENV]: String(MAX_SUBAGENT_DEPTH) }), false);
  assert.equal(isSubagentToolAllowed({ [DEPTH_ENV]: "99" }), false);
});

test("getSubagentName returns only non-empty agent names", () => {
  assert.equal(getSubagentName({}), undefined);
  assert.equal(getSubagentName({ [NAME_ENV]: "" }), undefined);
  assert.equal(getSubagentName({ [NAME_ENV]: "   " }), undefined);
  assert.equal(getSubagentName({ [NAME_ENV]: "worker" }), "worker");
});

test("buildChildEnv bumps depth, sets the agent name and inherits the parent pointer", () => {
  const base: ProcessEnvLike = { [PARENT_SESSION_ENV]: "sess-root", PATH: "/bin" };
  const child = buildChildEnv(base, "worker");
  assert.equal(child[DEPTH_ENV], "1");
  assert.equal(child[NAME_ENV], "worker");
  assert.equal(child[PARENT_SESSION_ENV], "sess-root", "parent pointer is inherited, not rewritten");
  assert.equal(child.PATH, "/bin");
  assert.notEqual(child[DEPTH_ENV], "0", "a child env must never carry depth \"0\"");

  // Base object is never mutated.
  assert.equal(base[DEPTH_ENV], undefined);
  assert.equal(base[NAME_ENV], undefined);

  // Existing valid depth is bumped; invalid depth restarts at 1.
  assert.equal(buildChildEnv({ ...base, [DEPTH_ENV]: "1" }, "inner")[DEPTH_ENV], "2");
  assert.equal(buildChildEnv({ ...base, [DEPTH_ENV]: "junk" }, "inner")[DEPTH_ENV], "1");
});

test("registerSessionEnv records the session id in root sessions and cleans it up on shutdown", async () => {
  const pi = new MockPi();
  const env: ProcessEnvLike = {};
  registerSessionEnv(pi.api, env);
  const { ctx, notifications } = createContext({ sessionId: "sess-42" });

  await pi.emitLifecycle("session_start", ctx);
  assert.equal(env[PARENT_SESSION_ENV], "sess-42");
  assert.deepEqual(notifications, []);

  // A later session_start (reload/new/resume) rewrites with the latest id.
  (ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => "sess-43";
  await pi.emitLifecycle("session_start", ctx);
  assert.equal(env[PARENT_SESSION_ENV], "sess-43");

  await pi.emitLifecycle("session_shutdown", ctx);
  assert.equal(env[PARENT_SESSION_ENV], undefined);

  // Repeated shutdown stays a no-op.
  await pi.emitLifecycle("session_shutdown", ctx);
  assert.equal(env[PARENT_SESSION_ENV], undefined);
});

test("registerSessionEnv keeps the inherited pointer in subagent sessions", async () => {
  const pi = new MockPi();
  const env: ProcessEnvLike = { [DEPTH_ENV]: "1", [PARENT_SESSION_ENV]: "parent-sess" };
  registerSessionEnv(pi.api, env);
  const { ctx, notifications } = createContext({ sessionId: "child-sess" });

  await pi.emitLifecycle("session_start", ctx);
  assert.equal(env[PARENT_SESSION_ENV], "parent-sess", "subagent sessions must not overwrite the pointer");
  assert.deepEqual(notifications, []);

  await pi.emitLifecycle("session_shutdown", ctx);
  assert.equal(env[PARENT_SESSION_ENV], "parent-sess", "nothing was set by us, so nothing is cleaned");
});

test("registerSessionEnv reports invalid session ids and getter errors without writing", async () => {
  const pi = new MockPi();
  const env: ProcessEnvLike = {};
  registerSessionEnv(pi.api, env);

  const blank = createContext({ sessionId: "   " });
  await pi.emitLifecycle("session_start", blank.ctx);
  assert.equal(env[PARENT_SESSION_ENV], undefined);
  assert.equal(blank.notifications.length, 1);
  assert.equal(blank.notifications[0].type, "error");

  const throwing = createContext({ sessionId: "x" });
  (throwing.ctx.sessionManager as { getSessionId: () => string }).getSessionId = () => {
    throw new Error("boom");
  };
  await pi.emitLifecycle("session_start", throwing.ctx);
  assert.equal(env[PARENT_SESSION_ENV], undefined);
  assert.equal(throwing.notifications.length, 1);
  assert.equal(throwing.notifications[0].type, "error");

  // Shutdown without a prior write stays a no-op.
  await pi.emitLifecycle("session_shutdown", blank.ctx);
  assert.equal(env[PARENT_SESSION_ENV], undefined);
});
