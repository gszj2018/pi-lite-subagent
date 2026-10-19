/**
 * End-to-end integration tests for the subagent tool: registrations are
 * assembled here with fake dependencies (mock env, mock spawn, temp agent dir).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { DEPTH_ENV, NAME_ENV } from "../extension/env-vars.ts";
import { registerSubagentTool } from "../extension/subagent-tool.ts";
import type { ProcessEnvLike, SubagentRunnerDeps } from "../extension/types.ts";
import { makeTempDir, withTempUserAgents } from "./helpers/agents-fixture.ts";
import { MockSpawn, assistantMessage, messageEndEvent } from "./helpers/mock-spawn.ts";
import { MockPi, createContext } from "./helpers/mocks.ts";

function makeDeps(spawnMock: MockSpawn, agentDir: string, env: ProcessEnvLike = {}): SubagentRunnerDeps {
  return {
    spawn: spawnMock.spawn,
    env,
    agentDir,
    piLaunch: { execPath: "/fake/bin/pi-runtime" },
    extensionArgs: { extensions: ["x.ts", "y.ts"], noExtensions: true },
  };
}

test("integration: parallel run spawns children with the full args/env/cwd contract", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const pi = new MockPi();
  const spawnMock = new MockSpawn([
    { stdoutLines: [messageEndEvent(assistantMessage("alpha-output"))] },
    { stdoutLines: [messageEndEvent(assistantMessage("beta-output"))] },
  ]);
  registerSubagentTool(pi.api, makeDeps(spawnMock, agentDir, { PATH: "/bin" }));

  const { ctx } = createContext({ cwd: "/work", trusted: true });
  const result = await pi.tools.get("subagent").execute(
    "c1",
    {
      tasks: [
        { agent: "worker", task: "first task" },
        { agent: "worker", task: "second task" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /alpha-output/);
  assert.match(result.content[0].text, /beta-output/);
  assert.equal(result.details.mode, "parallel");
  assert.equal(result.details.agentScope, "user");
  assert.equal(result.details.results.length, 2);
  for (const r of result.details.results) assert.deepEqual(r.state, { status: "exited", exitCode: 0 });

  assert.equal(spawnMock.calls.length, 2);
  for (const call of spawnMock.calls) {
    assert.equal(call.options.cwd, "/work");
    const env = call.options.env as Record<string, string | undefined>;
    assert.equal(env[DEPTH_ENV], "1");
    assert.equal(env[NAME_ENV], "worker");
    assert.equal(env.PATH, "/bin");
    // Inherited extension flags come first, in short form.
    assert.deepEqual(call.args.slice(0, 5), ["-ne", "-e", "x.ts", "-e", "y.ts"]);
    assert.ok(call.args.includes("--mode"));
    assert.ok(call.args.includes("--no-session"), "no persistence without a session dir");
    assert.ok(call.args.some((arg) => arg.startsWith("Task: ")));
  }
});

test("integration: chain run threads {previous} and reports the final output", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const pi = new MockPi();
  const spawnMock = new MockSpawn([
    { stdoutLines: [messageEndEvent(assistantMessage("RESULT-42"))] },
    { stdoutLines: [messageEndEvent(assistantMessage("final answer"))] },
  ]);
  registerSubagentTool(pi.api, makeDeps(spawnMock, agentDir));

  const { ctx } = createContext({ cwd: "/work", trusted: true });
  const result = await pi.tools.get("subagent").execute(
    "c1",
    {
      mode: "chain",
      tasks: [
        { agent: "worker", task: "produce" },
        { agent: "worker", task: "analyze {previous}" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "final answer");
  assert.equal(result.details.mode, "chain");
  assert.equal(result.details.results.length, 2);
  assert.ok(spawnMock.calls[1].args.includes("Task: analyze RESULT-42"));
});

test("integration: parent-session persistence creates the dir and emits --session-dir", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const sessionRoot = await makeTempDir("pi-lite-int-sess-");
  t.after(sessionRoot.cleanup);

  const pi = new MockPi();
  const spawnMock = new MockSpawn([{ stdoutLines: [messageEndEvent(assistantMessage("ok"))] }]);
  registerSubagentTool(pi.api, makeDeps(spawnMock, agentDir));

  const { ctx } = createContext({ cwd: "/work", trusted: true, sessionDir: sessionRoot.dir, sessionId: "sess-42" });
  const result = await pi.tools
    .get("subagent")
    .execute("c1", { tasks: [{ agent: "worker", task: "t" }] }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);

  const expectedDir = path.join(sessionRoot.dir, "lite-subagent", "sess-42");
  assert.ok(fs.existsSync(expectedDir), "the subagent session dir is really created");
  const args = spawnMock.calls[0].args;
  const index = args.indexOf("--session-dir");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], expectedDir);
  assert.equal(args.includes("--no-session"), false);
});
