import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { type BrowserController, type BrowserItem, createBrowserController } from "../extension/subagent-browser.ts";
import { registerSubagentHistory } from "../extension/subagent-history.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { callEntry, resultEntry, singleResult, task } from "./helpers/history-fixture.ts";
import { createContext, MockPi } from "./helpers/mocks.ts";

/** Capture the browser's public data boundary without exposing private history state. */
function createHistory() {
  const pi = new MockPi();
  const controller = createBrowserController(pi.api);
  let load!: Parameters<BrowserController["registerBrowser"]>[2];
  let subscribe!: NonNullable<Parameters<BrowserController["registerBrowser"]>[3]>;
  controller.registerBrowser = (_name, _description, onLoad, onSubscribe) => {
    load = onLoad;
    assert.ok(onSubscribe);
    subscribe = onSubscribe;
  };
  registerSubagentHistory(pi.api, controller);
  return {
    pi,
    read: (ctx: ExtensionContext) => load(ctx as ExtensionCommandContext).items,
    subscribe: (listener: () => void) => subscribe(listener),
  };
}

function readHistory(branch: unknown[]) {
  return createHistory().read(createContext({ branch }).ctx);
}

function detail(item: BrowserItem): string {
  return item.createDetail(new BrowserUI().theme).render(200).map(stripTerminalSequences).join("\n");
}

test("history orders both calls and their tasks newest first, including calls in one message", () => {
  const older = callEntry("older", [task("same", "repeat"), task("same", "repeat")]);
  const newer = callEntry("newer", [task("worker", "first"), task("worker", "second")]);
  newer.message.content.push(callEntry("last").message.content[0]);
  const branch = [older, { type: "compaction" }, newer, resultEntry("older", [], { isError: true, text: "blocked" })];
  const before = JSON.stringify(branch);
  const history = readHistory(branch);
  assert.deepEqual(history.map((item) => item.id), ["last:0", "newer:1", "newer:0", "older:1", "older:0"]);
  assert.deepEqual(history.map((item) => item.description), ["task", "second", "first", "repeat", "repeat"]);
  assert.equal(history[3].label, "same (Not executed)");
  assert.match(detail(history[3]), /blocked/);
  assert.equal(JSON.stringify(branch), before, "history extraction never mutates the branch");
});

test("results join by toolCallId rather than completion order or agent name", () => {
  const history = readHistory([
    callEntry("a"), callEntry("b"),
    resultEntry("b", [singleResult({ model: "model-b" })]),
    resultEntry("a", [singleResult({ model: "model-a", exitCode: 7, stderr: "failure" })]),
  ]);
  assert.deepEqual(history.map((item) => [item.id, item.label]), [
    ["b:0", "worker"], ["a:0", "worker (Failed)"],
  ]);
  assert.match(detail(history[0]), /Model: model-b/);
  assert.match(detail(history[1]), /Model: model-a/);
  assert.match(detail(history[1]), /Stderr: failure/);
});

test("history details show full commands and serialized arguments beyond compact summary limits", () => {
  const command = `echo ${"x".repeat(70)} COMMAND_END`;
  const args = { query: "x".repeat(65), extra: "ARGUMENT_END" };
  const [item] = readHistory([
    callEntry("c"), resultEntry("c", [singleResult({ messages: [{ role: "assistant", content: [
      { type: "toolCall", name: "bash", arguments: { command } },
      { type: "toolCall", name: "custom", arguments: args },
    ] }] })]),
  ]);
  const rendered = detail(item);
  assert.ok(rendered.includes(`$ ${command}`));
  assert.ok(rendered.includes(`custom ${JSON.stringify(args)}`));
});

test("chain results align by step, retain original tasks and mark unexecuted later steps skipped", () => {
  const history = readHistory([
    callEntry("chain", [task(), task("worker", "use {previous}"), task("worker", "never")], "chain"),
    resultEntry("chain", [
      singleResult({ step: 2, task: "use actual output", exitCode: 1 }),
      singleResult({ step: 1 }),
    ], { mode: "chain", isError: true }),
  ]);
  assert.deepEqual(history.map((item) => item.label), ["worker (Skipped)", "worker (Failed)", "worker"]);
  assert.deepEqual(history.map((item) => item.id), ["chain:2", "chain:1", "chain:0"]);
  assert.equal(history[1].description, "use");
  const executed = detail(history[1]);
  assert.match(executed, /Mode: chain · Step 2/);
  assert.match(executed, /Task: use \{previous\}/);
  assert.match(executed, /Executed task: use actual output/);
  assert.match(detail(history[0]), /Status: Skipped/);
});

test("result statuses distinguish failures, abortion, unfinished history and missing details", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ exitCode: 0 }, "Completed"], [{ exitCode: 5 }, "Failed"],
    [{ stopReason: "error" }, "Failed"], [{ stopReason: "aborted" }, "Aborted"],
    [{ exitCode: undefined, errorMessage: "provider error" }, "Failed"],
    [{ exitCode: undefined }, "Unknown / interrupted"],
  ];
  for (const [overrides, expected] of cases) {
    const persisted: unknown = JSON.parse(JSON.stringify(resultEntry("c", [singleResult(overrides)])));
    const [item] = readHistory([callEntry("c"), persisted]);
    assert.equal(item.label, expected === "Completed" ? "worker" : `worker (${expected})`);
    assert.ok(detail(item).includes(`Status: ${expected}`));
  }
  assert.equal(readHistory([callEntry("unfinished")])[0].label, "worker (Unknown / interrupted)");
  const [missing] = readHistory([
    callEntry("missing"), resultEntry("missing", [], { details: undefined, text: "tool failed", isError: true }),
  ]);
  assert.equal(missing.label, "worker (Result details unavailable)", "a generic tool error does not prove no work ran");
  assert.match(detail(missing), /tool failed/);
  const [mismatchedMode] = readHistory([
    callEntry("wrong-mode"), resultEntry("wrong-mode", [], { mode: "chain", isError: true }),
  ]);
  assert.equal(mismatchedMode.label, "worker (Result details unavailable)");
});

test("malformed branch entries and arguments retain task slots without interfering with valid calls", () => {
  const malformed = callEntry("bad", [null, task()]);
  const output = singleResult({ messages: [null, { role: "assistant", content: [null, { type: "text", text: "valid" }] }] });
  const history = readHistory([
    null, 7, {}, { type: "message", message: null }, malformed, callEntry("valid"),
    resultEntry("valid", [output]),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "other" }] } },
  ]);
  assert.deepEqual(history.map((item) => item.id), ["valid:0", "bad:1", "bad:0"]);
  assert.equal(history[2].label, "unknown (Unknown / interrupted)");
  assert.equal(history[2].description, "(invalid task)");
  assert.equal(history[0].label, "worker");
  assert.match(detail(history[0]), /valid/);
  const [mismatch] = readHistory([
    callEntry("x"), resultEntry("x", [singleResult({ agent: "another-agent" })]),
  ]);
  assert.equal(mismatch.label, "worker (Result details unavailable)");
  assert.match(detail(mismatch), /call output/);
  const invalidArgs = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", name: "subagent", id: "invalid", arguments: null },
  ] } };
  assert.equal(readHistory([invalidArgs])[0].description, "(invalid task)");
});

test("invalid details make every task's result unavailable while preserving call-level output", () => {
  for (const results of [
    [null, singleResult()],
    [singleResult(), singleResult({ usage: { input: "bad", output: Infinity, cost: -1 } })],
  ]) {
    const history = readHistory([
      callEntry("c", [task(), task("worker", "later")]),
      resultEntry("c", results, { isError: true, text: "fallback output" }),
    ]);
    assert.deepEqual(history.map((item) => item.id), ["c:1", "c:0"]);
    for (const item of history) {
      assert.equal(item.label, "worker (Result details unavailable)");
      assert.match(detail(item), /fallback output/);
      assert.doesNotMatch(detail(item), /answer/);
    }
  }
});

test("live history uses only getBranch and ignores nested, unrelated and off-branch events", async () => {
  const history = createHistory();
  const { pi } = history;
  const { ctx } = createContext({ entries: [callEntry("abandoned")], branch: [callEntry("active")] });
  await pi.emitLifecycle("session_start", ctx);
  for (const extra of [
    { toolCallId: "abandoned" }, { toolCallId: "active", parentToolCallId: "outer" },
    { toolCallId: "active", toolName: "read" },
  ]) {
    await pi.emitLifecycle("tool_execution_start", ctx, { toolName: "subagent", ...extra });
  }
  assert.deepEqual(history.read(ctx).map((item) => [item.id, item.label]), [["active:0", "worker (Unknown / interrupted)"]]);
  await pi.emitLifecycle("tool_execution_start", ctx, { toolName: "subagent", toolCallId: "active" });
  assert.equal(history.read(ctx)[0].label, "worker (Pending / running)");
});

test("concurrent top-level calls retain independent states even when they use the same agent", async () => {
  const history = createHistory();
  const { pi } = history;
  const { ctx } = createContext({ branch: [callEntry("a"), callEntry("b")] });
  for (const id of ["a", "b"]) {
    await pi.emitLifecycle("tool_execution_start", ctx, { toolName: "subagent", toolCallId: id });
  }
  await pi.emitLifecycle("tool_execution_end", ctx, {
    toolName: "subagent", toolCallId: "a", result: resultEntry("a").message, isError: false,
  });
  assert.deepEqual(history.read(ctx).map((item) => [item.id, item.label]), [
    ["b:0", "worker (Pending / running)"], ["a:0", "worker"],
  ]);
});

test("live partials are copied and invalid persisted details replace and release the cache", async () => {
  const history = createHistory();
  const { pi } = history;
  const branch: unknown[] = [callEntry("c")];
  const { ctx } = createContext({ branch });
  let changes = 0;
  const unsubscribe = history.subscribe(() => { changes++; });
  const event = { toolName: "subagent", toolCallId: "c" };
  await pi.emitLifecycle("tool_execution_start", ctx, event);
  const text = { type: "text", text: "original" };
  const args = { path: "original.ts" };
  const partial = singleResult({ exitCode: undefined, messages: [{ role: "assistant", content: [
    text, { type: "toolCall", name: "read", arguments: args },
  ] }] });
  await pi.emitLifecycle("tool_execution_update", ctx, { ...event, partialResult: resultEntry("c", [partial]).message });
  assert.ok(changes >= 2, "live events notify the registered browser subscriber");
  partial.usage.input = 999;
  text.text = "changed";
  args.path = "changed.ts";
  partial.messages.push({ role: "assistant", content: [{ type: "text", text: "unannounced mutation" }] });
  const running = history.read(ctx)[0];
  assert.equal(running.label, "worker (Pending / running)");
  const rendered = detail(running);
  assert.match(rendered, /original/);
  assert.match(rendered, /read original\.ts/);
  assert.match(rendered, /↑1\s/);
  assert.doesNotMatch(rendered, /changed|unannounced mutation|↑999/);
  await pi.emitLifecycle("tool_execution_end", ctx, { ...event, result: resultEntry("c").message, isError: false });
  assert.equal(history.read(ctx)[0].label, "worker");
  branch.push(resultEntry("c", [singleResult({ usage: {} })], { text: "redacted persisted output" }));
  const final = history.read(ctx)[0];
  assert.equal(final.label, "worker (Result details unavailable)");
  assert.match(detail(final), /redacted persisted output/);
  branch.pop();
  assert.equal(history.read(ctx)[0].label, "worker (Unknown / interrupted)", "the finalized live cache has been released");
  unsubscribe();
  const before = changes;
  await pi.emitLifecycle("tool_execution_start", ctx, event);
  assert.equal(changes, before);
});

test("message_end bridges the pre-persistence gap and turn_end refreshes the authoritative result", async () => {
  const history = createHistory();
  const { pi } = history;
  const branch: unknown[] = [callEntry("c")];
  const { ctx } = createContext({ branch });
  const final = resultEntry("c", [singleResult({ model: "before-persistence" })]);
  await pi.emitLifecycle("message_end", ctx, { message: final.message });
  assert.match(detail(history.read(ctx)[0]), /Model: before-persistence/);
  branch.push(resultEntry("c", [singleResult({ model: "persisted-replacement" })]));
  await pi.emitLifecycle("turn_end", ctx);
  assert.match(detail(history.read(ctx)[0]), /Model: persisted-replacement/);
});

test("chain live history exposes not-started tasks and settlement does not leave stale running states", async () => {
  const history = createHistory();
  const { pi } = history;
  const branch = [callEntry("c", [task(), task("worker", "later")], "chain")];
  const { ctx } = createContext({ branch });
  const event = { toolName: "subagent", toolCallId: "c" };
  await pi.emitLifecycle("tool_execution_start", ctx, event);
  await pi.emitLifecycle("tool_execution_update", ctx, {
    ...event, partialResult: resultEntry("c", [singleResult({ exitCode: undefined, step: 1 })], { mode: "chain" }).message,
  });
  assert.deepEqual(history.read(ctx).map((item) => item.label), ["worker (Not started)", "worker (Pending / running)"]);
  await pi.emitLifecycle("agent_settled", ctx);
  assert.deepEqual(history.read(ctx).map((item) => item.label), ["worker (Unknown / interrupted)", "worker (Unknown / interrupted)"]);
});

test("session changes, branch navigation and shutdown isolate observations without timers", async () => {
  const history = createHistory();
  const { pi } = history;
  const branch: unknown[] = [callEntry("c")];
  const a = createContext({ sessionId: "a", branch }).ctx;
  const b = createContext({ sessionId: "b", branch: [callEntry("c")] }).ctx;
  const event = { toolName: "subagent", toolCallId: "c" };
  await pi.emitLifecycle("session_start", a);
  await pi.emitLifecycle("tool_execution_start", a, event);
  assert.equal(history.read(b)[0].label, "worker (Unknown / interrupted)");
  branch.length = 0;
  await pi.emitLifecycle("session_tree", a);
  branch.push(callEntry("c"));
  assert.equal(history.read(a)[0].label, "worker (Unknown / interrupted)");
  await pi.emitLifecycle("session_shutdown", a);
  await pi.emitLifecycle("tool_execution_start", a, event);
  assert.equal(history.read(a)[0].label, "worker (Unknown / interrupted)");
  await pi.emitLifecycle("session_start", b);
  await pi.emitLifecycle("tool_execution_start", b, event);
  assert.equal(history.read(b)[0].label, "worker (Pending / running)");
});
