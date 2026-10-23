import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { getDisplayItems } from "../extension/result-parsing.ts";
import {
  appendDisplayItems, formatReadLineRange, formatToolCall, formatUsageStats,
} from "../extension/subagent-rendering.ts";
import { registerSubagentTool } from "../extension/subagent-tool.ts";
import { withTempUserAgents } from "./helpers/agents-fixture.ts";
import { BrowserUI } from "./helpers/browser-ui.ts";
import { resultEntry, singleResult } from "./helpers/history-fixture.ts";
import { MockSpawn } from "./helpers/mock-spawn.ts";
import { MockPi } from "./helpers/mocks.ts";

const fg = (_color: unknown, text: string) => text;

function messages() {
  return [
    { role: "assistant", content: [
      { type: "text", text: "repeat" }, { type: "thinking", thinking: "hidden reasoning" },
      { type: "toolCall", name: "read", arguments: { path: "src/main.ts", offset: null, limit: 4 } },
      { type: "text", text: "repeat" },
    ] },
    { role: "toolResult", content: [{ type: "text", text: "hidden tool output" }] },
    { role: "assistant", content: [{ type: "text", text: "final-once" }] },
  ];
}

test("display rendering preserves Markdown/tool-call order and repeated text", () => {
  const items = getDisplayItems(messages());
  const container = new Container();
  appendDisplayItems(container, items, new BrowserUI().theme);
  assert.equal(container.children.filter((child) => child instanceof Markdown).length, 3);
  const rendered = container.render(100).map(stripTerminalSequences).join("\n");
  assert.equal(rendered.match(/repeat/g)?.length, 2);
  assert.equal(rendered.match(/final-once/g)?.length, 1);
  assert.match(rendered, /read src\/main.ts:1-4/);
  assert.doesNotMatch(rendered, /hidden reasoning|hidden tool output/);
});

test("tool summaries tolerate malformed arguments and unserializable values", () => {
  assert.equal(formatToolCall("read", { path: 7, offset: "bad" }, fg), "read ...");
  assert.equal(formatToolCall("write", { path: "file", content: 42 }, fg), "write file");
  assert.equal(formatToolCall("grep", { path: [], pattern: {} }, fg), "grep // in .");
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.match(formatToolCall("custom", circular, fg), /unavailable arguments/);
});

test("usage, read ranges and normal compact tool summaries keep their existing formats", () => {
  assert.equal(formatReadLineRange(null, null), undefined);
  assert.equal(formatReadLineRange(undefined, 3), ":1-3");
  assert.equal(formatReadLineRange("4", "2"), ":4-5");
  assert.equal(formatReadLineRange(7, undefined), ":7");
  assert.equal(formatReadLineRange("bad", 3), undefined);
  assert.equal(formatToolCall("bash", { command: "echo hello" }, fg), "$ echo hello");
  assert.equal(formatToolCall("write", { path: "out", content: "a\nb" }, fg), "write out (2 lines)");
  assert.equal(formatToolCall("find", { pattern: "*.ts", path: "src" }, fg), "find *.ts in src");
  assert.equal(formatUsageStats({ input: 1234, output: 20000, cacheRead: 4, cacheWrite: 0, cost: 0.1, turns: 2 }, "p/m"),
    "2 turns ↑1.2k ↓20k R4 $0.1000 p/m");
});

test("tool expanded results still render all ordered items exactly once using the shared helpers", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const pi = new MockPi();
  const spawnMock = new MockSpawn();
  registerSubagentTool(pi.api, {
    agentDir, spawn: spawnMock.spawn, env: {}, piLaunch: { execPath: "/fake/pi" },
    extensionArgs: { extensions: [], noExtensions: false },
  });
  const result = resultEntry("c", [singleResult({ messages: messages() })]).message;
  const component = pi.tools.get("subagent").renderResult(result, { expanded: true }, new BrowserUI().theme, {});
  const rendered = component.render(100).map(stripTerminalSequences).join("\n");
  assert.equal(rendered.match(/repeat/g)?.length, 2);
  assert.equal(rendered.match(/final-once/g)?.length, 1);
  assert.ok(rendered.indexOf("repeat") < rendered.indexOf("read src/main.ts"));
  assert.ok(rendered.lastIndexOf("repeat") < rendered.indexOf("final-once"));
  assert.doesNotMatch(rendered, /hidden reasoning|hidden tool output|Ctrl\+O/);
  assert.equal(spawnMock.calls.length, 0);
});

test("tool results with missing, invalid or empty details fall back to call-level text", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const pi = new MockPi();
  const spawnMock = new MockSpawn();
  registerSubagentTool(pi.api, {
    agentDir, spawn: spawnMock.spawn, env: {}, piLaunch: { execPath: "/fake/pi" },
    extensionArgs: { extensions: [], noExtensions: false },
  });
  const tool = pi.tools.get("subagent");
  const theme = new BrowserUI().theme;
  const invalid = resultEntry("c", [singleResult(), null]).message;
  for (const result of [
    resultEntry("c", [], { details: undefined }).message, invalid, resultEntry("c", []).message,
  ]) {
    for (const expanded of [false, true]) {
      const component = tool.renderResult(result, { expanded }, theme, {});
      assert.equal(component.render(100).map(stripTerminalSequences).join("\n").trimEnd(), "call output");
    }
  }
  const empty = tool.renderResult({ ...invalid, content: [] }, { expanded: true }, theme, {});
  assert.equal(empty.render(100).map(stripTerminalSequences).join("\n").trimEnd(), "(no output)");
  assert.equal(spawnMock.calls.length, 0);
});

test("compact and running tool results retain their capped previews rather than the full expanded body", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const pi = new MockPi();
  registerSubagentTool(pi.api, {
    agentDir, spawn: new MockSpawn().spawn, env: {}, piLaunch: { execPath: "/fake/pi" },
    extensionArgs: { extensions: [], noExtensions: false },
  });
  const tool = pi.tools.get("subagent");
  const ui = new BrowserUI();
  const longMessages = Array.from({ length: 8 }, (_, index) => ({
    role: "assistant", content: [{ type: "text", text: `item-${index}\nsecond\nthird\nfourth-${index}` }],
  }));
  const complete = resultEntry("c", [singleResult({ messages: longMessages })]).message;
  const compact = tool.renderResult(complete, { expanded: false }, ui.theme, {}).render(100).map(stripTerminalSequences).join("\n");
  assert.match(compact, /3 earlier items/);
  assert.doesNotMatch(compact, /item-0|fourth-/);
  assert.match(compact, /Ctrl\+O to expand/);
  const running = JSON.parse(JSON.stringify(resultEntry("c", [
    singleResult({ exitCode: undefined, messages: longMessages }),
  ]).message));
  const expandedRunning = tool.renderResult(running, { expanded: true }, ui.theme, {}).render(100).map(stripTerminalSequences).join("\n");
  assert.match(expandedRunning, /3 earlier items/);
  assert.match(expandedRunning, /fourth-7/);
  assert.doesNotMatch(expandedRunning, /item-0/);
  const expanded = tool.renderResult(complete, { expanded: true }, ui.theme, {}).render(100).map(stripTerminalSequences).join("\n");
  assert.match(expanded, /item-0/);
  assert.match(expanded, /fourth-0/);
});
