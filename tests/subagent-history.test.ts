import assert from "node:assert/strict";
import { test } from "node:test";
import { collectSubagentHistory, registerSubagentHistory } from "../extension/subagent-history.ts";
import { callEntry, resultEntry, singleResult, task } from "./helpers/history-fixture.ts";
import { createContext, MockPi } from "./helpers/mocks.ts";

test("history orders both calls and their tasks newest first, including calls in one message", () => {
  const older = callEntry("older", [task("same", "repeat"), task("same", "repeat")]);
  const newer = callEntry("newer", [task("worker", "first"), task("worker", "second")]);
  newer.message.content.push(callEntry("last").message.content[0]);
  const branch = [older, { type: "compaction" }, newer, resultEntry("older", [], { isError: true, text: "blocked" })];
  const before = JSON.stringify(branch);
  const history = collectSubagentHistory(branch);
  assert.deepEqual(history.map((item) => item.id), ["last:0", "newer:1", "newer:0", "older:1", "older:0"]);
  assert.deepEqual(history.map((item) => item.task), ["task", "second", "first", "repeat", "repeat"]);
  assert.equal(history[3].status, "Not executed");
  assert.equal(history[3].callOutput, "blocked");
  assert.equal(JSON.stringify(branch), before, "history extraction never mutates the branch");
});

test("results join by toolCallId rather than completion order or agent name", () => {
  const history = collectSubagentHistory([
    callEntry("a"), callEntry("b"),
    resultEntry("b", [singleResult({ model: "model-b" })]),
    resultEntry("a", [singleResult({ model: "model-a", exitCode: 7, stderr: "failure" })]),
  ]);
  assert.deepEqual(history.map((item) => [item.toolCallId, item.result?.model, item.status]), [
    ["b", "model-b", "Completed"], ["a", "model-a", "Failed"],
  ]);
});

test("chain results align by step, retain original tasks and mark unexecuted later steps skipped", () => {
  const history = collectSubagentHistory([
    callEntry("chain", [task(), task("worker", "use {previous}"), task("worker", "never")], "chain"),
    resultEntry("chain", [
      singleResult({ step: 2, task: "use actual output", exitCode: 1 }),
      singleResult({ step: 1 }),
    ], { mode: "chain", isError: true }),
  ]);
  assert.deepEqual(history.map((item) => item.status), ["Skipped", "Failed", "Completed"]);
  assert.deepEqual(history.map((item) => item.index), [2, 1, 0]);
  assert.equal(history[1].task, "use {previous}");
  assert.equal(history[1].result?.task, "use actual output");
  assert.equal(history[0].result, undefined);
});

test("result statuses distinguish failures, abortion, unfinished history and missing details", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ exitCode: 0 }, "Completed"], [{ exitCode: 5 }, "Failed"],
    [{ stopReason: "error" }, "Failed"], [{ stopReason: "aborted" }, "Aborted"],
    [{ exitCode: undefined, errorMessage: "provider error" }, "Failed"],
    [{ exitCode: undefined }, "Unknown / interrupted"],
  ];
  for (const [overrides, expected] of cases) {
    const [item] = collectSubagentHistory([callEntry("c"), resultEntry("c", [singleResult(overrides)])]);
    assert.equal(item.status, expected);
  }
  assert.equal(collectSubagentHistory([callEntry("unfinished")])[0].status, "Unknown / interrupted");
  const [missing] = collectSubagentHistory([
    callEntry("missing"), resultEntry("missing", [], { details: undefined, text: "tool failed", isError: true }),
  ]);
  assert.equal(missing.status, "Result details unavailable", "a generic tool error does not prove no work ran");
  assert.equal(missing.callOutput, "tool failed");
  const [mismatchedMode] = collectSubagentHistory([
    callEntry("wrong-mode"), resultEntry("wrong-mode", [], { mode: "chain", isError: true }),
  ]);
  assert.equal(mismatchedMode.status, "Result details unavailable");
});

test("malformed entries and result holes cannot shift another task's result into the wrong slot", () => {
  const malformed = callEntry("bad", [null, task()]);
  const output = singleResult({ messages: [null, { role: "assistant", content: [null, { type: "text", text: "valid" }] }],
    usage: { input: "bad", output: Infinity, cost: -1 } });
  const history = collectSubagentHistory([
    null, 7, {}, { type: "message", message: null }, malformed,
    resultEntry("bad", [null, output]),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "other" }] } },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[1].agent, "unknown");
  assert.equal(history[1].status, "Result details unavailable");
  assert.equal(history[0].status, "Completed");
  assert.deepEqual(history[0].result?.items, [{ type: "text", text: "valid" }]);
  assert.equal(history[0].result?.usage.input, 0);
  assert.equal(history[0].result?.usage.output, 0);
  assert.equal(history[0].result?.usage.cost, 0);
  const mismatch = collectSubagentHistory([
    callEntry("x"), resultEntry("x", [singleResult({ agent: "another-agent" })]),
  ]);
  assert.equal(mismatch[0].result, undefined);
  const invalidArgs = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", name: "subagent", id: "invalid", arguments: null },
  ] } };
  assert.equal(collectSubagentHistory([invalidArgs])[0].task, "(invalid task)");
});

test("live history uses only getBranch and ignores nested, unrelated and off-branch events", async () => {
  const pi = new MockPi();
  const history = registerSubagentHistory(pi.api);
  const { ctx } = createContext({ entries: [callEntry("abandoned")], branch: [callEntry("active")] });
  await pi.emitLifecycle("session_start", ctx);
  for (const extra of [
    { toolCallId: "abandoned" }, { toolCallId: "active", parentToolCallId: "outer" },
    { toolCallId: "active", toolName: "read" },
  ]) {
    await pi.emitLifecycle("tool_execution_start", ctx, { toolName: "subagent", ...extra });
  }
  assert.deepEqual(history.read(ctx).map((item) => [item.toolCallId, item.status]), [["active", "Unknown / interrupted"]]);
  await pi.emitLifecycle("tool_execution_start", ctx, { toolName: "subagent", toolCallId: "active" });
  assert.equal(history.read(ctx)[0].status, "Pending / running");
});

test("concurrent top-level calls retain independent states even when they use the same agent", async () => {
  const pi = new MockPi();
  const history = registerSubagentHistory(pi.api);
  const { ctx } = createContext({ branch: [callEntry("a"), callEntry("b")] });
  for (const id of ["a", "b"]) {
    await pi.emitLifecycle("tool_execution_start", ctx, { toolName: "subagent", toolCallId: id });
  }
  await pi.emitLifecycle("tool_execution_end", ctx, {
    toolName: "subagent", toolCallId: "a", result: resultEntry("a").message, isError: false,
  });
  assert.deepEqual(history.read(ctx).map((item) => [item.toolCallId, item.status]), [
    ["b", "Pending / running"], ["a", "Completed"],
  ]);
});

test("live partials are copied into display data and final persisted data replaces and releases the cache", async () => {
  const pi = new MockPi();
  const history = registerSubagentHistory(pi.api);
  const branch: unknown[] = [callEntry("c")];
  const { ctx } = createContext({ branch });
  let changes = 0;
  const unsubscribe = history.subscribe(() => { changes++; });
  const event = { toolName: "subagent", toolCallId: "c" };
  await pi.emitLifecycle("tool_execution_start", ctx, event);
  const partial = singleResult({ exitCode: undefined });
  await pi.emitLifecycle("tool_execution_update", ctx, { ...event, partialResult: resultEntry("c", [partial]).message });
  partial.usage.input = 999;
  partial.messages.push({ role: "assistant", content: [{ type: "text", text: "unannounced mutation" }] });
  const running = history.read(ctx)[0];
  assert.equal(running.status, "Pending / running");
  assert.equal(running.result?.usage.input, 1);
  assert.equal(running.result?.items.length, 1);
  await pi.emitLifecycle("tool_execution_end", ctx, { ...event, result: resultEntry("c").message, isError: false });
  assert.equal(history.read(ctx)[0].status, "Completed");
  branch.push(resultEntry("c", [], { details: undefined, text: "redacted persisted output" }));
  const final = history.read(ctx)[0];
  assert.equal(final.status, "Result details unavailable");
  assert.equal(final.callOutput, "redacted persisted output");
  branch.pop();
  assert.equal(history.read(ctx)[0].status, "Unknown / interrupted", "the finalized live cache has been released");
  unsubscribe();
  const before = changes;
  await pi.emitLifecycle("tool_execution_start", ctx, event);
  assert.equal(changes, before);
});

test("message_end bridges the pre-persistence gap and turn_end refreshes the authoritative result", async () => {
  const pi = new MockPi();
  const history = registerSubagentHistory(pi.api);
  const branch: unknown[] = [callEntry("c")];
  const { ctx } = createContext({ branch });
  const final = resultEntry("c", [singleResult({ model: "before-persistence" })]);
  await pi.emitLifecycle("message_end", ctx, { message: final.message });
  assert.equal(history.read(ctx)[0].result?.model, "before-persistence");
  branch.push(resultEntry("c", [singleResult({ model: "persisted-replacement" })]));
  await pi.emitLifecycle("turn_end", ctx);
  assert.equal(history.read(ctx)[0].result?.model, "persisted-replacement");
});

test("chain live history exposes not-started tasks and settlement does not leave stale running states", async () => {
  const pi = new MockPi();
  const history = registerSubagentHistory(pi.api);
  const branch = [callEntry("c", [task(), task("worker", "later")], "chain")];
  const { ctx } = createContext({ branch });
  const event = { toolName: "subagent", toolCallId: "c" };
  await pi.emitLifecycle("tool_execution_start", ctx, event);
  await pi.emitLifecycle("tool_execution_update", ctx, {
    ...event, partialResult: resultEntry("c", [singleResult({ exitCode: undefined, step: 1 })], { mode: "chain" }).message,
  });
  assert.deepEqual(history.read(ctx).map((item) => item.status), ["Not started", "Pending / running"]);
  await pi.emitLifecycle("agent_settled", ctx);
  assert.deepEqual(history.read(ctx).map((item) => item.status), ["Unknown / interrupted", "Unknown / interrupted"]);
});

test("session changes, branch navigation and shutdown isolate observations without timers", async () => {
  const pi = new MockPi();
  const history = registerSubagentHistory(pi.api);
  const branch: unknown[] = [callEntry("c")];
  const a = createContext({ sessionId: "a", branch }).ctx;
  const b = createContext({ sessionId: "b", branch: [callEntry("c")] }).ctx;
  const event = { toolName: "subagent", toolCallId: "c" };
  await pi.emitLifecycle("session_start", a);
  await pi.emitLifecycle("tool_execution_start", a, event);
  assert.equal(history.read(b)[0].status, "Unknown / interrupted");
  branch.length = 0;
  await pi.emitLifecycle("session_tree", a);
  branch.push(callEntry("c"));
  assert.equal(history.read(a)[0].status, "Unknown / interrupted");
  await pi.emitLifecycle("session_shutdown", a);
  await pi.emitLifecycle("tool_execution_start", a, event);
  assert.equal(history.read(a)[0].status, "Unknown / interrupted");
  await pi.emitLifecycle("session_start", b);
  await pi.emitLifecycle("tool_execution_start", b, event);
  assert.equal(history.read(b)[0].status, "Pending / running");
});
