import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPTH_ENV, NAME_ENV } from "../extension/env-vars.ts";
import { registerSubagentTool } from "../extension/subagent-tool.ts";
import { withTempUserAgents } from "./helpers/agents-fixture.ts";
import { removeTruncationArtifact } from "./helpers/cleanup.ts";
import { MockSpawn, assistantMessage, messageEndEvent, type MockProcScript } from "./helpers/mock-spawn.ts";
import { MockPi, createContext, flushPromises } from "./helpers/mocks.ts";

function setupTool(agentDir: string, scripts: MockProcScript[] = []) {
  const pi = new MockPi();
  const spawnMock = new MockSpawn(scripts);
  registerSubagentTool(pi.api, {
    spawn: spawnMock.spawn,
    env: {},
    agentDir,
    piLaunch: { execPath: "/fake/bin/pi-runtime" },
    extensionArgs: { extensions: [], noExtensions: false },
  });
  const tool = pi.tools.get("subagent");
  assert.ok(tool, "subagent tool registered");
  return { pi, tool, spawnMock };
}

test("project/both scope fails on untrusted projects without spawning", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  for (const agentScope of ["project", "both"] as const) {
    const { tool, spawnMock } = setupTool(agentDir);
    const { ctx } = createContext({ trusted: false });
    const result = await tool.execute(
      "c1",
      { tasks: [{ agent: "worker", task: "t" }], agentScope },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(result.isError, true, agentScope);
    assert.match(result.content[0].text, /not trusted/);
    assert.match(result.content[0].text, new RegExp(`agentScope "${agentScope}"`));
    assert.equal(spawnMock.calls.length, 0, agentScope);
    assert.deepEqual(result.details.results, []);
    assert.equal(result.details.projectAgentsDir, null);
    assert.equal(result.details.mode, "parallel");
    assert.equal(result.details.agentScope, agentScope);
  }
});

test("user scope runs on untrusted projects", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const { tool, spawnMock } = setupTool(agentDir, [{ stdoutLines: [messageEndEvent(assistantMessage("ok"))] }]);
  const { ctx } = createContext({ trusted: false });
  const result = await tool.execute("c1", { tasks: [{ agent: "worker", task: "t" }] }, undefined, undefined, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(spawnMock.calls.length, 1);
  assert.match(result.content[0].text, /ok/);

  const env = spawnMock.calls[0].options.env as Record<string, string | undefined>;
  assert.equal(env[DEPTH_ENV], "1");
  assert.equal(env[NAME_ENV], "worker");
});

test("task count is validated before spawning", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const { tool, spawnMock } = setupTool(agentDir);
  const { ctx } = createContext({ trusted: true });

  const empty = await tool.execute("c1", { tasks: [] }, undefined, undefined, ctx);
  assert.equal(empty.isError, true);
  assert.match(empty.content[0].text, /at least one task/);

  const tooMany = await tool.execute(
    "c2",
    { tasks: Array.from({ length: 9 }, (_, i) => ({ agent: "worker", task: `t${i}` })) },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content[0].text, /Too many tasks \(9\)\. Max is 8\./);
  assert.equal(spawnMock.calls.length, 0);
});

test("chain mode threads {previous} through steps and returns the final output", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const { tool, spawnMock } = setupTool(agentDir, [
    { stdoutLines: [messageEndEvent(assistantMessage("RESULT-A"))] },
    { stdoutLines: [messageEndEvent(assistantMessage("done"))] },
  ]);
  const { ctx } = createContext({ trusted: true });
  const result = await tool.execute(
    "c1",
    {
      mode: "chain",
      tasks: [
        { agent: "worker", task: "produce" },
        { agent: "worker", task: "analyze {previous} end" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, "done");
  assert.equal(spawnMock.calls.length, 2);
  assert.ok(spawnMock.calls[1].args.includes("Task: analyze RESULT-A end"));
  assert.equal(result.details.mode, "chain");
  assert.deepEqual(result.details.results.map((r: { step: number }) => r.step), [1, 2]);
});

test("chain mode stops at the first failure and reports the failing step", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const { tool, spawnMock } = setupTool(agentDir, [
    { stderr: "boom", exitCode: 1 },
    { stdoutLines: [messageEndEvent(assistantMessage("never"))] },
  ]);
  const { ctx } = createContext({ trusted: true });
  const result = await tool.execute(
    "c1",
    {
      mode: "chain",
      tasks: [
        { agent: "worker", task: "first" },
        { agent: "worker", task: "second" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Chain stopped at step 1 \(worker\): boom/);
  assert.equal(spawnMock.calls.length, 1, "second step must not run");
  assert.equal(result.details.results.length, 1);
});

test("parallel mode bounds concurrency and reports per-task summaries", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const scripts: MockProcScript[] = Array.from({ length: 6 }, (_, i) => ({
    hold: true,
    stdoutLines: [messageEndEvent(assistantMessage(`out-${i}`))],
  }));
  const { tool, spawnMock } = setupTool(agentDir, scripts);
  const { ctx } = createContext({ trusted: true });
  const promise = tool.execute(
    "c1",
    { tasks: Array.from({ length: 6 }, (_, i) => ({ agent: "worker", task: `task-${i}` })) },
    undefined,
    undefined,
    ctx,
  );

  await flushPromises();
  assert.equal(spawnMock.calls.length, 4, "at most 4 concurrent tasks");
  assert.equal(spawnMock.aliveCount, 4);

  spawnMock.procs[0].release(0);
  spawnMock.procs[1].release(0);
  await flushPromises();
  assert.equal(spawnMock.calls.length, 6);
  assert.equal(spawnMock.aliveCount, 4);

  for (const proc of spawnMock.procs) proc.release(0);
  const result = await promise;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^Parallel: 6\/6 succeeded/);
  assert.match(result.content[0].text, /### \[worker\] completed/);
  assert.equal(result.details.mode, "parallel");
  assert.equal(result.details.results.length, 6);
  for (const r of result.details.results) assert.deepEqual(r.state, { status: "exited", exitCode: 0 });
});

test("a single task completes in either mode", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  for (const mode of ["parallel", "chain"] as const) {
    const { tool, spawnMock } = setupTool(agentDir, [{ stdoutLines: [messageEndEvent(assistantMessage("solo"))] }]);
    const { ctx } = createContext({ trusted: true });
    const result = await tool.execute("c1", { mode, tasks: [{ agent: "worker", task: "only" }] }, undefined, undefined, ctx);
    assert.equal(spawnMock.calls.length, 1, mode);
    assert.equal(result.isError, undefined, mode);
    assert.match(result.content[0].text, /solo/, mode);
    assert.equal(result.details.results.length, 1, mode);
    assert.equal(result.details.mode, mode);
  }
});

const HINT_PATH = /\[Output truncated: [^\]]*Full output saved to: (.+?)\]/;

test("parallel summaries and chain error output carry the truncation hint", async (t) => {
  const { agentDir } = await withTempUserAgents(t);
  const { ctx } = createContext({ trusted: true });
  const bigText = "y".repeat(60 * 1024); // over the host default cap

  const parallel = setupTool(agentDir, [{ stdoutLines: [messageEndEvent(assistantMessage(bigText))] }]);
  const parallelResult = await parallel.tool.execute(
    "c1",
    { tasks: [{ agent: "worker", task: "t" }] },
    undefined,
    undefined,
    ctx,
  );
  const parallelHint = parallelResult.content[0].text.match(HINT_PATH);
  assert.ok(parallelHint, "parallel summary carries the truncation hint");
  t.after(() => removeTruncationArtifact(parallelHint[1]));

  const chain = setupTool(agentDir, [{ stderr: bigText, exitCode: 1 }]);
  const chainResult = await chain.tool.execute(
    "c2",
    { mode: "chain", tasks: [{ agent: "worker", task: "t" }] },
    undefined,
    undefined,
    ctx,
  );
  const chainHint = chainResult.content[0].text.match(HINT_PATH);
  assert.ok(chainHint, "chain stop message carries the truncation hint");
  t.after(() => removeTruncationArtifact(chainHint[1]));
});
