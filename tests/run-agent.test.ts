import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import type { AgentConfig } from "../extension/agents.ts";
import { DEPTH_ENV, NAME_ENV, PARENT_SESSION_ENV } from "../extension/env-vars.ts";
import { buildPiArgs, getPiInvocation, isPathSafeSessionId, runSingleAgent } from "../extension/run-agent.ts";
import type { InheritedExtensionArgs, SingleResult, SubagentDetails, SubagentRunnerDeps } from "../extension/types.ts";
import { makeTempDir, withTempUserAgents } from "./helpers/agents-fixture.ts";
import {
  MockSpawn,
  assistantMessage,
  basicUsage,
  messageEndEvent,
  toolResultEvent,
} from "./helpers/mock-spawn.ts";
import { createContext, flushPromises } from "./helpers/mocks.ts";

const noExtensionArgs: InheritedExtensionArgs = { extensions: [], noExtensions: false };

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "worker agent",
    systemPrompt: "",
    source: "user",
    filePath: "/agents/worker.md",
    ...overrides,
  };
}

function makeDetails(results: SingleResult[]): SubagentDetails {
  return { mode: "parallel", agentScope: "user", projectAgentsDir: null, results };
}

function makeDeps(
  spawnMock: MockSpawn,
  agentDir: string,
  extensionArgs: InheritedExtensionArgs = noExtensionArgs,
): SubagentRunnerDeps {
  return {
    spawn: spawnMock.spawn,
    env: {},
    agentDir,
    piLaunch: { execPath: "/fake/bin/pi-runtime" },
    extensionArgs,
  };
}

test("buildPiArgs inherits the dispatch model only when the agent defines no model", () => {
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent({ model: "p/mine" }), task: "t", dispatchModel: "p/dispatch", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "--model", "p/mine", "Task: t"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent(), task: "t", dispatchModel: "p/dispatch", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "--model", "p/dispatch", "Task: t"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent(), task: "t", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "Task: t"],
  );
});

test("buildPiArgs thinking override matrix: explicit thinking always wins, dispatch level needs no model", () => {
  // agent.thinking set: wins regardless of model.
  assert.deepEqual(
    buildPiArgs({
      agent: makeAgent({ model: "p/mine", thinking: "high" }),
      task: "t",
      dispatchThinking: "low",
      extensionArgs: noExtensionArgs,
    }),
    ["--mode", "json", "-p", "--no-session", "--model", "p/mine", "--thinking", "high", "Task: t"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent({ thinking: "max" }), task: "t", dispatchThinking: "low", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "--thinking", "max", "Task: t"],
  );
  // agent.thinking unset: dispatch level only inherited when the agent has no model.
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent({ model: "p/mine" }), task: "t", dispatchThinking: "low", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "--model", "p/mine", "Task: t"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent(), task: "t", dispatchThinking: "low", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "--thinking", "low", "Task: t"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent(), task: "t", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "Task: t"],
  );
});

test("buildPiArgs emits tools, prompt file and the trailing task positional", () => {
  assert.deepEqual(
    buildPiArgs({
      agent: makeAgent({ tools: ["read", "bash"] }),
      task: "hello world",
      promptFilePath: "/tmp/p.md",
      extensionArgs: noExtensionArgs,
    }),
    ["--mode", "json", "-p", "--no-session", "--tools", "read,bash", "--append-system-prompt", "/tmp/p.md", "Task: hello world"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent({ tools: [] }), task: "t", extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "Task: t"],
  );
});

test("buildPiArgs places inherited extension flags first in short form", () => {
  const args = buildPiArgs({
    agent: makeAgent(),
    task: "t",
    extensionArgs: { extensions: ["a.ts", "b.ts"], noExtensions: true },
  });
  assert.deepEqual(args.slice(0, 5), ["-ne", "-e", "a.ts", "-e", "b.ts"]);
  assert.deepEqual(args.slice(5, 8), ["--mode", "json", "-p"]);

  const onlyExtensions = buildPiArgs({
    agent: makeAgent(),
    task: "t",
    extensionArgs: { extensions: ["x.ts"], noExtensions: false },
  });
  assert.deepEqual(onlyExtensions.slice(0, 2), ["-e", "x.ts"]);
  assert.equal(onlyExtensions[2], "--mode");

  const bare = buildPiArgs({ agent: makeAgent(), task: "t", extensionArgs: noExtensionArgs });
  assert.deepEqual(bare.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);
});

test("runSingleAgent aggregates usage and captures stop metadata", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([
    {
      stdoutLines: [
        messageEndEvent(assistantMessage("first", { usage: basicUsage(), model: "p/m1", stopReason: "toolUse" })),
        toolResultEvent("tool output"),
        messageEndEvent(assistantMessage("final", { usage: basicUsage(), stopReason: "end" })),
      ],
    },
  ]);
  const { ctx } = createContext({ cwd: "/workspace" });
  const result = await runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "do work",
    dispatchDefaults: {},
    makeDetails,
  });

  assert.deepEqual(result.state, { status: "exited", exitCode: 0 });
  assert.equal(result.messages.length, 3);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.usage.input, 20);
  assert.equal(result.usage.output, 10);
  assert.equal(result.usage.cacheRead, 4);
  assert.equal(result.usage.cacheWrite, 2);
  assert.equal(result.usage.cost, 0.5);
  assert.equal(result.usage.contextTokens, 100);
  assert.equal(result.model, "p/m1");
  assert.equal(result.stopReason, "end");

  assert.equal(spawnMock.calls.length, 1);
  assert.equal(spawnMock.calls[0].options.cwd, "/workspace");
});

test("runSingleAgent short-circuits unknown agents without spawning", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn();
  const { ctx } = createContext();
  const result = await runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent({ name: "known" })],
    agentName: "missing",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });

  assert.deepEqual(result.state, { status: "exited", exitCode: 1 });
  assert.equal(result.agentSource, "unknown");
  assert.match(result.stderr, /Unknown agent: "missing"/);
  assert.match(result.stderr, /"known"/);
  assert.equal(spawnMock.calls.length, 0);
});

test("runSingleAgent reports non-zero exits and collects stderr", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([
    { stderr: "boom\n", exitCode: 7, stdoutLines: [messageEndEvent(assistantMessage("partial"))] },
  ]);
  const { ctx } = createContext();
  const result = await runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });

  assert.deepEqual(result.state, { status: "exited", exitCode: 7 });
  assert.equal(result.stderr, "boom\n");
  assert.equal(result.messages.length, 1);
});

test("runSingleAgent writes and cleans up the system-prompt temp file", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([{}]);
  const { ctx } = createContext();
  const result = await runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent({ systemPrompt: "You are helpful." })],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });

  assert.deepEqual(result.state, { status: "exited", exitCode: 0 });
  const args = spawnMock.calls[0].args;
  const index = args.indexOf("--append-system-prompt");
  assert.notEqual(index, -1);
  const promptPath = args[index + 1]!;
  assert.ok(promptPath.endsWith("prompt-worker.md"));
  assert.equal(fs.existsSync(promptPath), false, "prompt temp file cleaned up");
});

test("runSingleAgent aborts with SIGTERM and reports an aborted run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([{ hold: true }]);
  const { ctx } = createContext();
  const controller = new AbortController();
  const promise = runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    signal: controller.signal,
    makeDetails,
  });
  await flushPromises();
  controller.abort();
  await assert.rejects(promise, /Subagent was aborted/);
  assert.deepEqual(spawnMock.procs[0].kills, ["SIGTERM"]);
});

test("runSingleAgent escalates to SIGKILL when SIGTERM is ignored", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([{ hold: true, ignoreTerm: true }]);
  const { ctx } = createContext();
  const controller = new AbortController();
  const promise = runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    signal: controller.signal,
    makeDetails,
  });
  await flushPromises();
  controller.abort();
  await flushPromises();
  assert.deepEqual(spawnMock.procs[0].kills, ["SIGTERM"]);
  assert.equal(spawnMock.procs[0].released, false, "process must still be alive after SIGTERM is ignored");

  t.mock.timers.tick(5000);
  assert.deepEqual(spawnMock.procs[0].kills, ["SIGTERM", "SIGKILL"]);
  await assert.rejects(promise, /Subagent was aborted/);
});

test("runSingleAgent does not leave a pending kill timer when the process closes promptly", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([{ hold: true }]);
  const { ctx } = createContext();
  const controller = new AbortController();
  const promise = runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    signal: controller.signal,
    makeDetails,
  });
  await flushPromises();
  controller.abort();
  await assert.rejects(promise, /Subagent was aborted/);
  // The escalation timer was cleared on close: ticking past it must not kill again.
  t.mock.timers.tick(60_000);
  assert.deepEqual(spawnMock.procs[0].kills, ["SIGTERM"]);
});

test("getPiInvocation resolves the launch from injected inputs", async (t) => {
  const tmp = await makeTempDir("pi-lite-invocation-");
  t.after(tmp.cleanup);
  const scriptPath = path.join(tmp.dir, "pi-entry.mjs");
  await fs.promises.writeFile(scriptPath, "// stub", "utf-8");

  // Existing script: run through the runtime with the script as the first argument.
  assert.deepEqual(
    getPiInvocation({ execPath: "/fake/bin/node", piScriptPath: scriptPath, args: ["--mode", "json"] }),
    { command: "/fake/bin/node", args: [scriptPath, "--mode", "json"] },
  );

  // Missing script with a generic runtime: fall back to the pi command.
  assert.deepEqual(
    getPiInvocation({ execPath: "/fake/bin/node", piScriptPath: path.join(tmp.dir, "missing.mjs"), args: ["a"] }),
    { command: "pi", args: ["a"] },
  );

  // A bun virtual script path is never used as the entry script.
  assert.deepEqual(
    getPiInvocation({ execPath: "/fake/bin/bun", piScriptPath: "/$bunfs/root/cli", args: ["a"] }),
    { command: "pi", args: ["a"] },
  );

  // Windows-style generic runtime name.
  assert.deepEqual(
    getPiInvocation({ execPath: "C:\\runtime\\node.exe", piScriptPath: undefined, args: ["a"] }),
    { command: "pi", args: ["a"] },
  );

  // Non-generic runtime binary: invoke it directly without a script.
  assert.deepEqual(
    getPiInvocation({ execPath: "/fake/bin/pi-bin", args: ["a"] }),
    { command: "/fake/bin/pi-bin", args: ["a"] },
  );
});

test("runSingleAgent spawns with the built child env", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const spawnMock = new MockSpawn([{ stdoutLines: [messageEndEvent(assistantMessage("ok"))] }]);
  const { ctx } = createContext();
  const result = await runSingleAgent({
    deps: { ...makeDeps(spawnMock, agentDir), env: { [PARENT_SESSION_ENV]: "sess-root", PATH: "/bin" } },
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "do work",
    dispatchDefaults: {},
    makeDetails,
  });
  assert.deepEqual(result.state, { status: "exited", exitCode: 0 });

  const env = spawnMock.calls[0].options.env as Record<string, string | undefined>;
  assert.equal(env[DEPTH_ENV], "1");
  assert.equal(env[NAME_ENV], "worker");
  assert.equal(env[PARENT_SESSION_ENV], "sess-root", "the parent session pointer is inherited");
  assert.equal(env.PATH, "/bin");
});

test("buildPiArgs emits the session policy for persist and no-session forms", () => {
  assert.deepEqual(
    buildPiArgs({
      agent: makeAgent(),
      task: "t",
      session: { mode: "persist", dir: "/w/.pi/sessions/lite-subagent/s1" },
      extensionArgs: noExtensionArgs,
    }),
    ["--mode", "json", "-p", "--session-dir", "/w/.pi/sessions/lite-subagent/s1", "Task: t"],
  );
  assert.deepEqual(
    buildPiArgs({ agent: makeAgent(), task: "t", session: { mode: "no-session" }, extensionArgs: noExtensionArgs }),
    ["--mode", "json", "-p", "--no-session", "Task: t"],
  );
});

test("isPathSafeSessionId accepts only simple path-safe ids", () => {
  for (const id of ["a", "abc", "A1", "0", "sess-1_2.3x"]) assert.equal(isPathSafeSessionId(id), true, id);
  for (const id of ["", " a", "a ", "/x", "a/b", "a\\b", "a b", "..", ".abc", "abc.", "-a", "a-", "a$b"]) {
    assert.equal(isPathSafeSessionId(id), false, JSON.stringify(id));
  }
});

test("runSingleAgent persists subagent sessions under the parent session dir", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const tmp = await makeTempDir("pi-lite-session-");
  t.after(tmp.cleanup);
  const spawnMock = new MockSpawn([{}]);
  const { ctx } = createContext({ sessionDir: tmp.dir, sessionId: "sess-7" });
  const result = await runSingleAgent({
    deps: makeDeps(spawnMock, agentDir),
    ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });
  assert.deepEqual(result.state, { status: "exited", exitCode: 0 });

  const expectedDir = path.join(tmp.dir, "lite-subagent", "sess-7");
  assert.ok(fs.existsSync(expectedDir), "the session dir is really created");
  const args = spawnMock.calls[0].args;
  const index = args.indexOf("--session-dir");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], expectedDir);
  assert.equal(args.includes("--no-session"), false);
});

test("runSingleAgent falls back to --no-session when persistence is not possible", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  // No session dir configured (no persistence).
  const noDir = new MockSpawn([{}]);
  await runSingleAgent({
    deps: makeDeps(noDir, agentDir),
    ctx: createContext().ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });
  assert.ok(noDir.calls[0].args.includes("--no-session"), "no session dir");

  // Unsafe session id: never touches the file system.
  const unsafe = new MockSpawn([{}]);
  await runSingleAgent({
    deps: makeDeps(unsafe, agentDir),
    ctx: createContext({ sessionDir: "/nonexistent-root", sessionId: "../evil" }).ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });
  assert.ok(unsafe.calls[0].args.includes("--no-session"), "unsafe session id");

  // The session dir cannot be created (a file blocks the path): degrade.
  const tmp = await makeTempDir("pi-lite-session-");
  t.after(tmp.cleanup);
  await fs.promises.writeFile(path.join(tmp.dir, "lite-subagent"), "file, not a directory", "utf-8");
  const blocked = new MockSpawn([{}]);
  await runSingleAgent({
    deps: makeDeps(blocked, agentDir),
    ctx: createContext({ sessionDir: tmp.dir, sessionId: "s1" }).ctx,
    agents: [makeAgent()],
    agentName: "worker",
    task: "t",
    dispatchDefaults: {},
    makeDetails,
  });
  assert.ok(blocked.calls[0].args.includes("--no-session"), "blocked session dir");
});
