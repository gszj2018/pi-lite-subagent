/** Fake lifecycle and registered-command tests over self-cleaning temp sessions; no real Pi or terminal. */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerActiveAgentMarker } from "../extension/active-agent.ts";
import { currentSessionFile, registerSessionNavigation } from "../extension/session-navigation.ts";
import type { NavigationState, NavigationPending } from "../extension/types.ts";
import { createContext, MockPi } from "./helpers/mocks.ts";
import { withTempSessions } from "./helpers/sessions-fixture.ts";

async function fixture(t: TestContext) {
  const files = await withTempSessions(t);
  const child = await files.child();
  const state: NavigationState = { frames: [] };
  const runtime = (file: string) => {
    const pi = new MockPi();
    const mock = createContext({ sessionFile: file });
    const ctx = mock.ctx as unknown as ExtensionCommandContext;
    registerSessionNavigation(pi.api, state);
    registerActiveAgentMarker(pi.api, {}, state);
    const invoke = async (name: string) => { await pi.commands.get(name)!.handler("", ctx); };
    return { pi, ctx, invoke, notifications: mock.notifications };
  };
  return { files, parent: files.parent.file, child: child.file, state, runtime };
}

test("navigation registration owns its two commands without registering browser history", async (t) => {
  const f = await fixture(t);
  const source = f.runtime(f.parent);
  assert.deepEqual([...source.pi.commands.keys()], ["switch-to-subagent-session", "return-to-parent-session"]);
  assert.equal(source.pi.count("message_end"), 0);
});

test("current sessions resolve directory aliases to real paths", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.files.projectDir, "linked-sessions");
  await fs.symlink(f.files.sessionDir, alias, "junction");
  const source = f.runtime(path.join(alias, "parent.jsonl"));
  assert.equal(currentSessionFile(source.ctx), await fs.realpath(f.parent));
  assert.throws(() => currentSessionFile(createContext().ctx), /file path/);
  assert.throws(() => currentSessionFile(createContext({ sessionFile: path.join(alias, "missing.jsonl") }).ctx),
    { code: "ENOENT" });
});

test("pop commit errors clear navigation state when the stack is empty or its top does not match", async (t) => {
  const f = await fixture(t);
  for (const frames of [[], [f.child]]) {
    f.state.frames = frames;
    f.state.pending = { operation: "pop", from: f.child, to: f.parent };
    const target = f.runtime(f.parent);
    await target.pi.emitLifecycle("session_start", target.ctx, "resume");
    assert.match(target.notifications[0].message, /Return transaction does not match.*cleared/);
    assert.equal(target.notifications[0].type, "error");
    assert.equal(f.state.frames, frames);
    assert.deepEqual(f.state, { frames: [] });
  }
});

test("cancelled or failed return commands roll back only their own pending object, never newer state", async (t) => {
  const f = await fixture(t);
  f.state.frames = [f.parent];
  const source = f.runtime(f.child);
  const frames = f.state.frames;
  const before = [...frames];
  for (const failure of [false, true]) {
    const notices = source.notifications.length;
    source.ctx.switchSession = async () => {
      if (failure) throw new Error("switch failed");
      return { cancelled: true };
    };
    await source.invoke("return-to-parent-session");
    if (failure) assert.match(source.notifications.at(-1)!.message, /switch failed/);
    assert.equal(source.notifications.length, notices + Number(failure));
    assert.equal(f.state.frames, frames);
    assert.deepEqual(f.state.frames, before);
    assert.equal(f.state.pending, undefined);
  }
  for (const failure of [false, true]) {
    let newer: NavigationPending | undefined;
    source.ctx.switchSession = async () => {
      newer = { ...f.state.pending! };
      f.state.pending = newer;
      if (failure) throw new Error("old switch failed");
      return { cancelled: true };
    };
    await source.invoke("return-to-parent-session");
    if (failure) assert.match(source.notifications.at(-1)!.message, /old switch failed/);
    assert.ok(newer);
    assert.equal(f.state.pending, newer);
    assert.equal(f.state.frames, frames);
    assert.deepEqual(f.state.frames, before);
    delete f.state.pending;
  }
  source.ctx.switchSession = async () => {
    const target = f.runtime(f.parent);
    await target.pi.emitLifecycle("session_start", target.ctx, "resume");
    assert.deepEqual(target.notifications, []);
    return { cancelled: true };
  };
  await source.invoke("return-to-parent-session");
  assert.deepEqual(f.state, { frames: [] }, "late cancellation preserves the target runtime's committed pop");
});

test("replacement gates resolve target aliases and repeatedly allow only matching idle pending switches", async (t) => {
  const f = await fixture(t);
  const source = f.runtime(f.parent);
  f.state.frames = [f.parent];
  assert.deepEqual(await source.pi.emitLifecycle("session_before_switch", source.ctx,
    { reason: "resume", targetSessionFile: f.child }), [{ cancel: true }]);
  const alias = path.join(f.files.projectDir, "linked-child-sessions");
  await fs.symlink(path.dirname(f.child), alias, "junction");
  const pending: NavigationPending = { operation: "push", from: f.parent, to: f.child };
  f.state.pending = pending;
  for (const file of [f.child, path.join(alias, "child.jsonl")]) {
    assert.deepEqual(await source.pi.emitLifecycle("session_before_switch", source.ctx,
      { reason: "resume", targetSessionFile: file }), [undefined]);
    assert.equal(f.state.pending, pending);
  }
  for (const event of [
    { reason: "new" }, { reason: "resume", targetSessionFile: f.parent },
    { reason: "resume", targetSessionFile: "child.jsonl" },
  ]) assert.deepEqual(await source.pi.emitLifecycle("session_before_switch", source.ctx, event), [{ cancel: true }]);
  assert.deepEqual(await source.pi.emitLifecycle("session_before_fork", source.ctx), [{ cancel: true }]);
  source.ctx.isIdle = () => false;
  assert.deepEqual(await source.pi.emitLifecycle("session_before_switch", source.ctx,
    { reason: "resume", targetSessionFile: f.child }), [{ cancel: true }]);
  source.ctx.isIdle = () => true;
  source.ctx.hasPendingMessages = () => true;
  assert.deepEqual(await source.pi.emitLifecycle("session_before_switch", source.ctx,
    { reason: "resume", targetSessionFile: f.child }), [{ cancel: true }]);
  source.ctx.hasPendingMessages = () => false;
  source.ctx.sessionManager.getSessionFile = () => f.child;
  assert.deepEqual(await source.pi.emitLifecycle("session_before_switch", source.ctx,
    { reason: "resume", targetSessionFile: f.child }), [{ cancel: true }]);
  assert.equal(f.state.pending, pending);
});

test("startup commits at the pending target and clears navigation for every other path", async (t) => {
  const f = await fixture(t);
  const unrelated = await f.files.child(f.files.parent, "unrelated");
  for (const operation of ["push", "pop"] as const) {
    const from = operation === "push" ? f.parent : f.child;
    const to = operation === "push" ? f.child : f.parent;
    for (const current of [from, to, unrelated.file]) {
      f.state.frames = operation === "push" ? [] : [f.parent];
      f.state.pending = { operation, from, to };
      const source = f.runtime(current);
      await source.pi.emitLifecycle("session_start", source.ctx);
      const frames = current === to && operation === "push" ? [from] : [];
      assert.deepEqual(f.state, { frames });
      assert.equal(source.notifications.length, current === to ? 0 : 1);
      if (current !== to) assert.match(source.notifications[0].message, /transaction does not match.*cleared/);
    }
  }
});

test("a return failure after teardown leaves pending for fresh-runtime validation without accessing stale context", async (t) => {
  const f = await fixture(t);
  f.state.frames = [f.parent];
  const source = f.runtime(f.child);
  source.ctx.switchSession = async () => {
    await source.pi.emitLifecycle("session_shutdown", source.ctx, "resume");
    const stale = () => { throw new Error("stale context"); };
    source.ctx.ui.notify = stale;
    source.ctx.sessionManager.getSessionFile = stale;
    source.ctx.isIdle = stale;
    throw new Error("replacement failed");
  };
  await source.invoke("return-to-parent-session");
  assert.deepEqual(f.state.pending, { operation: "pop", from: f.child, to: f.parent });
  const recovered = f.runtime(f.child);
  await recovered.pi.emitLifecycle("session_start", recovered.ctx, "reload");
  assert.deepEqual(f.state, { frames: [] });
  assert.equal(recovered.notifications[0].type, "error");
  assert.match(recovered.notifications[0].message, /transaction does not match.*cleared/);
});
