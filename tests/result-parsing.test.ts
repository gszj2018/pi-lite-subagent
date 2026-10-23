import assert from "node:assert/strict";
import { test } from "node:test";
import { getDisplayItems, getTextContent, parseSubagentDetails } from "../extension/result-parsing.ts";
import type { SubagentDetails } from "../extension/types.ts";

function details(): SubagentDetails {
  return {
    mode: "parallel",
    agentScope: "user",
    projectAgentsDir: null,
    results: [{
      agent: "worker", agentSource: "user", task: "task", messages: [], stderr: "",
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 3, turns: 1 },
    }],
  };
}

test("details parsing accepts complete results, optional metadata, empty results and extra fields without mutation", () => {
  for (const mode of ["parallel", "chain"] as const) {
    for (const agentScope of ["user", "project", "both"] as const) {
      const source = {
        ...details(), mode, agentScope, projectAgentsDir: "/project/.pi/agents", extra: "retained",
      };
      Object.assign(source.results[0], {
        agentSource: agentScope === "both" ? "unknown" : agentScope,
        exitCode: 0, model: "provider/model", stopReason: "end", errorMessage: "", step: 1,
      });
      const before = structuredClone(source);
      assert.equal(parseSubagentDetails(source), source);
      assert.deepEqual(source, before);
    }
  }
  const empty = { ...details(), results: [] };
  assert.equal(parseSubagentDetails(empty), empty);
});

test("details parsing accepts missing or undefined exit codes before and after JSON persistence", () => {
  const source = details();
  assert.equal(parseSubagentDetails(source), source);
  source.results[0].exitCode = undefined;
  source.results[0].model = undefined;
  assert.equal(parseSubagentDetails(source), source);
  const persisted: unknown = JSON.parse(JSON.stringify(source));
  const parsed = parseSubagentDetails(persisted);
  assert.ok(parsed);
  assert.equal(parsed.results[0].exitCode, undefined);
  for (const exitCode of [0, 1, -1]) {
    source.results[0].exitCode = exitCode;
    assert.equal(parseSubagentDetails(source)?.results[0].exitCode, exitCode);
  }
});

test("details parsing rejects invalid envelopes or any invalid result rather than retaining partial results", () => {
  const source = details();
  const withResult = (overrides: Record<string, unknown>) => ({
    ...source, results: [source.results[0], { ...source.results[0], ...overrides }],
  });
  const invalid: unknown[] = [
    undefined, null, [], {},
    { ...source, mode: "single" }, { ...source, agentScope: "unknown" },
    { ...source, projectAgentsDir: undefined }, { ...source, projectAgentsDir: 7 },
    { ...source, results: null }, { ...source, results: [source.results[0], null] },
    withResult({ agent: undefined }), withResult({ agentSource: "both" }), withResult({ task: 7 }),
    withResult({ messages: null }), withResult({ stderr: undefined }), withResult({ usage: {} }),
    withResult({ exitCode: null }), withResult({ exitCode: "0" }), withResult({ exitCode: 0.5 }),
    withResult({ exitCode: Infinity }), withResult({ model: 7 }), withResult({ stopReason: null }),
    withResult({ errorMessage: [] }), withResult({ step: 0 }), withResult({ step: 1.5 }),
  ];
  for (const [index, value] of invalid.entries()) {
    assert.equal(parseSubagentDetails(value), undefined, `invalid case ${index}`);
  }
});

test("details parsing rejects missing, negative, non-finite or non-numeric usage without repairing the input", () => {
  const source = details();
  const result = source.results[0];
  for (const key of Object.keys(result.usage)) {
    for (const value of [undefined, -1, NaN, Infinity, "1"]) {
      const invalid = { ...source, results: [{ ...result, usage: { ...result.usage, [key]: value } }] };
      const before = structuredClone(invalid);
      assert.equal(parseSubagentDetails(invalid), undefined, `invalid usage ${key}: ${String(value)}`);
      assert.deepEqual(invalid, before);
    }
  }
});

test("details validation leaves unknown messages to the defensive assistant-item parser", () => {
  const source = details();
  source.results[0].messages = [
    null, 42, {}, { role: "assistant", content: "invalid" },
    { role: "assistant", content: [
      null, { type: "text", text: 7 }, { type: "text", text: "repeat" },
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "toolCall", name: "read", arguments: { path: "file.ts" } },
      { type: "text", text: "repeat" },
    ] },
    { role: "toolResult", content: [{ type: "text", text: "hidden tool output" }] },
    { role: "assistant", content: [{ type: "text", text: "final" }] },
  ];
  const before = structuredClone(source);
  const parsed = parseSubagentDetails(source);
  assert.ok(parsed);
  assert.deepEqual(getDisplayItems(parsed.results[0].messages), [
    { type: "text", text: "repeat" },
    { type: "toolCall", name: "read", args: { path: "file.ts" } },
    { type: "text", text: "repeat" }, { type: "text", text: "final" },
  ]);
  assert.deepEqual(source, before);
});

test("assistant-item parsing falls back for malformed arguments and snapshots valid argument objects", () => {
  const args = { path: "original.ts" };
  const source = [{ role: "assistant", content: [
    { type: "toolCall", name: "read", arguments: args },
    { type: "toolCall", name: "read", arguments: null },
    { type: "toolCall", name: "read", arguments: [] },
    { type: "toolCall", name: "read", arguments: "invalid" },
    { type: "toolCall", name: 7 },
  ] }];
  const items = getDisplayItems(source);
  assert.equal(args.path, "original.ts");
  args.path = "changed.ts";
  assert.deepEqual(items, [
    { type: "toolCall", name: "read", args: { path: "original.ts" } },
    { type: "toolCall", name: "read", args: {} },
    { type: "toolCall", name: "read", args: {} },
    { type: "toolCall", name: "read", args: {} },
  ]);
});

test("call-level text extraction supports string and block content while ignoring malformed or non-text items", () => {
  assert.equal(getTextContent("plain output"), "plain output");
  for (const value of [undefined, null, 7, {}]) assert.equal(getTextContent(value), "");
  const content = [
    null, 7, { type: "text", text: false }, { type: "text", text: "first" },
    { type: "image", data: "hidden" }, { type: "text", text: "second" },
  ];
  const before = structuredClone(content);
  assert.equal(getTextContent(content), "first\nsecond");
  assert.deepEqual(content, before);
});
