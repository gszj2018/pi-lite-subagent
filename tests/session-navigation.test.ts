/** Pure state and fake lifecycle tests; no real environment, session files or runtime switches. */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerActiveAgentMarker } from "../extension/active-agent.ts";
import { RETURN_STACK_ENV } from "../extension/env-vars.ts";
import { MAX_RETURN_STACK_BYTES, parseNavigationState, registerSessionNavigation, serializeNavigationState,
  type NavigationState, type ReturnFrame } from "../extension/session-navigation.ts";
import type { SessionIdentity } from "../extension/session-paths.ts";
import type { ProcessEnvLike } from "../extension/types.ts";
import { createContext, MockPi } from "./helpers/mocks.ts";

const identity = (id: string): SessionIdentity => ({ file: path.resolve("virtual-sessions", `${id}.jsonl`), id });
const parent = identity("parent");
const child = identity("child");
const frame: ReturnFrame = { parent, child };
const state = (frames: ReturnFrame[] = [frame]): NavigationState => ({ version: 1, frames });

function runtime(current: SessionIdentity, env: ProcessEnvLike = {}) {
  const pi = new MockPi();
  const mock = createContext({ sessionId: current.id, sessionFile: current.file });
  const ctx = mock.ctx as unknown as ExtensionCommandContext;
  const navigation = registerSessionNavigation(pi.api, env);
  registerActiveAgentMarker(pi.api, env);
  return { pi, ctx, navigation, env, notifications: mock.notifications };
}

test("navigation registration owns its two commands without registering browser history", () => {
  const f = runtime(parent);
  assert.deepEqual([...f.pi.commands.keys()], ["switch-to-subagent-session", "return-to-parent-session"]);
  assert.equal(f.pi.count("message_end"), 0);
});

test("navigation state checks version, identities, chain continuity, cycles and pending operations", () => {
  assert.deepEqual(parseNavigationState(undefined), state([]));
  assert.equal(serializeNavigationState(state([])), undefined);
  const raw = serializeNavigationState(state())!;
  assert.deepEqual(parseNavigationState(raw), state());
  for (const invalid of ["", "null", "[]", "{}", '{"version":2,"frames":[]}', JSON.stringify({
    version: 1, frames: [{ parent: { ...parent, file: "relative.jsonl" }, child }],
  }), JSON.stringify(state([{ parent, child }, { parent, child: identity("other") }])),
  JSON.stringify(state([{ parent, child: parent }])), JSON.stringify({ ...state(), pending: {
    token: "token", operation: "pop", from: child, to: identity("wrong-parent"),
  } })]) assert.throws(() => parseNavigationState(invalid));
  const frames = Array.from({ length: 4 }, (_, index) => ({ parent: identity(`n${index}`), child: identity(`n${index + 1}`) }));
  assert.equal(parseNavigationState(serializeNavigationState(state(frames))).frames.length, 4);
  assert.throws(() => serializeNavigationState(state([...frames, { parent: identity("n4"), child: identity("n5") }])));
  assert.throws(() => serializeNavigationState({ ...state(frames), pending: {
    token: "token", operation: "push", from: identity("n4"), to: identity("n5"),
  } }));
});

test("the 4 KiB limit includes pending JSON and counts UTF-8 bytes rather than characters", () => {
  const raw = JSON.stringify(state());
  assert.equal(parseNavigationState(raw + " ".repeat(MAX_RETURN_STACK_BYTES - Buffer.byteLength(raw))).frames.length, 1);
  assert.throws(() => parseNavigationState(raw + " ".repeat(MAX_RETURN_STACK_BYTES - Buffer.byteLength(raw) + 1)));
  const unicode = JSON.stringify(state([{ parent: { ...parent, file: path.resolve("汉".repeat(1400), "parent.jsonl") }, child }]));
  assert.ok(unicode.length < MAX_RETURN_STACK_BYTES);
  assert.ok(Buffer.byteLength(unicode) > MAX_RETURN_STACK_BYTES);
  assert.throws(() => parseNavigationState(unicode));
});

test("fresh runtimes commit push/pop before marker scanning, keep reload state and clear only on quit", async () => {
  const env: ProcessEnvLike = {};
  const source = runtime(parent, env);
  await source.pi.emitLifecycle("session_start", source.ctx);
  source.ctx.switchSession = async () => {
    assert.equal(parseNavigationState(env[RETURN_STACK_ENV]).frames.length, 0, "pending alone is not committed");
    assert.ok(env[RETURN_STACK_ENV]);
    assert.deepEqual(await source.pi.emitLifecycle("input", source.ctx, { text: "pending env protects input" }),
      [{ action: "handled" }]);
    const gate = await source.pi.emitLifecycle("session_before_switch", source.ctx,
      { reason: "resume", targetSessionFile: child.file });
    assert.ok(gate.every((result) => result === undefined));
    await source.pi.emitLifecycle("session_shutdown", source.ctx, "resume");
    return { cancelled: false };
  };
  await source.navigation.switch(source.ctx, "push", parent, child);
  const target = runtime(child, env);
  await target.pi.emitLifecycle("session_start", target.ctx, "resume");
  assert.deepEqual(parseNavigationState(env[RETURN_STACK_ENV]).frames, [frame]);
  target.ctx.sessionManager.getSessionId = () => { throw new Error("input must not revalidate identity"); };
  assert.deepEqual(await target.pi.emitLifecycle("input", target.ctx, { text: "blocked" }), [{ action: "handled" }]);
  target.ctx.sessionManager.getSessionId = () => child.id;
  await target.pi.emitLifecycle("session_shutdown", target.ctx, "reload");
  assert.ok(env[RETURN_STACK_ENV]);
  const reloaded = runtime(child, env);
  await reloaded.pi.emitLifecycle("session_start", reloaded.ctx, "reload");
  reloaded.ctx.switchSession = async () => ({ cancelled: false });
  await reloaded.navigation.switch(reloaded.ctx, "pop", child, parent);
  const returned = runtime(parent, env);
  await returned.pi.emitLifecycle("session_start", returned.ctx, "resume");
  assert.equal(env[RETURN_STACK_ENV], undefined);
  assert.deepEqual(await returned.pi.emitLifecycle("input", returned.ctx, { text: "allowed" }), [undefined]);
  env[RETURN_STACK_ENV] = serializeNavigationState(state());
  await returned.pi.emitLifecycle("session_shutdown", returned.ctx, "quit");
  assert.equal(env[RETURN_STACK_ENV], undefined);
});

test("cancellation and pre-teardown failures roll back only the matching transaction", async () => {
  const env: ProcessEnvLike = { [RETURN_STACK_ENV]: serializeNavigationState(state()) };
  const f = runtime(child, env);
  await f.pi.emitLifecycle("session_start", f.ctx);
  const before = env[RETURN_STACK_ENV];
  f.ctx.switchSession = async () => ({ cancelled: true });
  await f.navigation.switch(f.ctx, "pop", child, parent);
  assert.equal(env[RETURN_STACK_ENV], before);
  f.ctx.switchSession = async () => { throw new Error("before teardown"); };
  await assert.rejects(f.navigation.switch(f.ctx, "pop", child, parent), /before teardown/);
  assert.equal(env[RETURN_STACK_ENV], before);
  f.ctx.switchSession = async () => {
    const newer = parseNavigationState(env[RETURN_STACK_ENV]);
    newer.pending!.token = "newer-token";
    env[RETURN_STACK_ENV] = serializeNavigationState(newer);
    return { cancelled: true };
  };
  await f.navigation.switch(f.ctx, "pop", child, parent);
  assert.equal(parseNavigationState(env[RETURN_STACK_ENV]).pending?.token, "newer-token");
});

test("invalid reads clear and notify; oversized writes preserve the previous valid stack", async () => {
  const env: ProcessEnvLike = { [RETURN_STACK_ENV]: "not-json" };
  const f = runtime(child, env);
  await f.pi.emitLifecycle("session_start", f.ctx);
  assert.equal(env[RETURN_STACK_ENV], undefined);
  assert.deepEqual(await f.pi.emitLifecycle("input", f.ctx, { text: "cleared" }), [undefined]);
  assert.equal(f.notifications[0].type, "error");
  env[RETURN_STACK_ENV] = serializeNavigationState(state());
  const before = env[RETURN_STACK_ENV];
  await assert.rejects(f.navigation.switch(f.ctx, "push", child, {
    file: path.resolve("汉".repeat(1500), "large.jsonl"), id: "large",
  }), /4 KiB/);
  assert.equal(env[RETURN_STACK_ENV], before);
  env[RETURN_STACK_ENV] = "bad";
  assert.throws(() => f.navigation.check(f.ctx), /cleared/);
  assert.equal(env[RETURN_STACK_ENV], undefined);
  const frames = Array.from({ length: 4 }, (_, index) => ({ parent: identity(`n${index}`), child: identity(`n${index + 1}`) }));
  const full: ProcessEnvLike = { [RETURN_STACK_ENV]: serializeNavigationState(state(frames)) };
  const last = runtime(identity("n4"), full);
  const original = full[RETURN_STACK_ENV];
  await assert.rejects(last.navigation.switch(last.ctx, "push", identity("n4"), identity("n5")), /four layers/);
  assert.equal(full[RETURN_STACK_ENV], original);
});

test("new/resume/fork/clone gates preserve valid state and consume the authorized credential once", async () => {
  const env: ProcessEnvLike = { [RETURN_STACK_ENV]: serializeNavigationState(state()) };
  const f = runtime(child, env);
  await f.pi.emitLifecycle("session_start", f.ctx);
  const before = env[RETURN_STACK_ENV];
  for (const event of [{ reason: "new" }, { reason: "resume", targetSessionFile: parent.file }]) {
    assert.deepEqual(await f.pi.emitLifecycle("session_before_switch", f.ctx, event), [{ cancel: true }]);
    assert.equal(env[RETURN_STACK_ENV], before);
  }
  for (const position of ["before", "at"]) {
    assert.deepEqual(await f.pi.emitLifecycle("session_before_fork", f.ctx, { entryId: "entry", position }), [{ cancel: true }]);
  }
  f.ctx.switchSession = async () => {
    assert.deepEqual(await f.pi.emitLifecycle("session_before_switch", f.ctx,
      { reason: "resume", targetSessionFile: parent.file }), [undefined]);
    assert.deepEqual(await f.pi.emitLifecycle("session_before_switch", f.ctx,
      { reason: "resume", targetSessionFile: parent.file }), [{ cancel: true }]);
    return { cancelled: true };
  };
  await f.navigation.switch(f.ctx, "pop", child, parent);
  assert.equal(env[RETURN_STACK_ENV], before);
  const waiting = runtime(parent);
  await waiting.pi.emitLifecycle("session_start", waiting.ctx);
  waiting.env[RETURN_STACK_ENV] = serializeNavigationState({ ...state([]), pending: {
    token: "env-only-token", operation: "push", from: parent, to: child,
  } });
  assert.deepEqual(await waiting.pi.emitLifecycle("session_before_switch", waiting.ctx,
    { reason: "resume", targetSessionFile: child.file }), [{ cancel: true }], "env presence alone grants no permit");
  assert.equal(parseNavigationState(waiting.env[RETURN_STACK_ENV]).pending?.token, "env-only-token");
});

test("startup reconciles interrupted source/target transactions and clears mismatched committed stacks", async () => {
  const pending = { token: "token", operation: "push" as const, from: parent, to: child };
  for (const [current, expectedDepth] of [[parent, 0], [child, 1], [identity("unrelated"), 0]] as const) {
    const env: ProcessEnvLike = { [RETURN_STACK_ENV]: serializeNavigationState({ ...state([]), pending }) };
    const f = runtime(current, env);
    await f.pi.emitLifecycle("session_start", f.ctx);
    assert.equal(parseNavigationState(env[RETURN_STACK_ENV]).frames.length, expectedDepth);
    assert.equal(parseNavigationState(env[RETURN_STACK_ENV]).pending, undefined);
    assert.equal(f.notifications.length, current.id === "unrelated" ? 1 : 0);
  }
  const env: ProcessEnvLike = { [RETURN_STACK_ENV]: serializeNavigationState(state()) };
  const f = runtime(parent, env);
  await f.pi.emitLifecycle("session_start", f.ctx);
  assert.equal(env[RETURN_STACK_ENV], undefined);
  assert.equal(f.notifications.length, 1);
});

test("a failure after teardown preserves pending recovery without touching the stale context", async () => {
  const env: ProcessEnvLike = {};
  const f = runtime(parent, env);
  await f.pi.emitLifecycle("session_start", f.ctx);
  f.ctx.switchSession = async () => {
    await f.pi.emitLifecycle("session_shutdown", f.ctx, "resume");
    f.ctx.ui.notify = () => { throw new Error("stale UI"); };
    throw new Error("replacement runtime failed");
  };
  await f.navigation.switch(f.ctx, "push", parent, child);
  assert.ok(parseNavigationState(env[RETURN_STACK_ENV]).pending);
  const recovered = runtime(parent, env);
  await recovered.pi.emitLifecycle("session_start", recovered.ctx, "reload");
  assert.equal(env[RETURN_STACK_ENV], undefined);
});
