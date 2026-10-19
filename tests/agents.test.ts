import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents, parseThinkingLevel } from "../extension/agents.ts";
import { agentMarkdown, makeTempDir, writeAgentFile } from "./helpers/agents-fixture.ts";

test("parseThinkingLevel accepts every supported level and rejects anything else", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(parseThinkingLevel(level), level);
  }
  for (const value of ["", "HIGH", "none", " medium", "max ", "123", 123, null, undefined, true, {}, ["high"]]) {
    assert.equal(parseThinkingLevel(value), undefined, JSON.stringify(value));
  }
});

test("agent files parse tolerantly: tools normalization, optional fields, invalid files skipped", async (t) => {
  const tmp = await makeTempDir("pi-lite-agents-");
  t.after(tmp.cleanup);
  const agentDir = join(tmp.dir, "agent-dir");
  const userAgents = join(agentDir, "agents");
  await writeAgentFile(
    userAgents,
    "string-tools.md",
    agentMarkdown({ name: "string-tools", description: "d", tools: "read, bash", model: "prov/m1", thinking: "high" }, "Prompt A"),
  );
  await writeAgentFile(
    userAgents,
    "array-tools.md",
    "---\nname: array-tools\ndescription: d\ntools: [read, edit]\nthinking: 42\n---\n\nPrompt B",
  );
  await writeAgentFile(userAgents, "no-name.md", "---\ndescription: d\n---\nbody");
  await writeAgentFile(userAgents, "no-description.md", "---\nname: x\n---\nbody");
  await writeAgentFile(userAgents, "readme.txt", "not an agent file");
  await writeAgentFile(userAgents, "bad-thinking.md", agentMarkdown({ name: "bad-thinking", description: "d", thinking: "extreme" }));

  const { agents } = discoverAgents(agentDir, tmp.dir, "user");
  const byName = new Map(agents.map((a) => [a.name, a]));
  assert.deepEqual([...byName.keys()].sort(), ["array-tools", "bad-thinking", "string-tools"]);

  const stringTools = byName.get("string-tools")!;
  assert.deepEqual(stringTools.tools, ["read", "bash"]);
  assert.equal(stringTools.model, "prov/m1");
  assert.equal(stringTools.thinking, "high");
  assert.ok(stringTools.systemPrompt.includes("Prompt A"));
  assert.equal(stringTools.source, "user");

  assert.deepEqual(byName.get("array-tools")!.tools, ["read", "edit"]);
  assert.equal(byName.get("array-tools")!.thinking, undefined);
  assert.equal(byName.get("bad-thinking")!.thinking, undefined);
  assert.equal(byName.get("bad-thinking")!.tools, undefined);
  assert.equal(byName.get("bad-thinking")!.model, undefined);
});

test("missing agent directories yield no agents and no project directory", async (t) => {
  const tmp = await makeTempDir("pi-lite-agents-");
  t.after(tmp.cleanup);
  const missingAgentDir = join(tmp.dir, "missing-agent-dir");

  for (const scope of ["user", "project", "both"] as const) {
    const result = discoverAgents(missingAgentDir, tmp.dir, scope);
    assert.deepEqual(result.agents, [], scope);
    assert.equal(result.projectAgentsDir, null, scope);
  }
});

test("scope selects user/project/both and project overrides same-name user agents", async (t) => {
  const tmp = await makeTempDir("pi-lite-agents-");
  t.after(tmp.cleanup);
  const agentDir = join(tmp.dir, "agent-dir");
  const userAgents = join(agentDir, "agents");
  const project = join(tmp.dir, "project");
  const projectAgents = join(project, ".pi", "agents");
  await writeAgentFile(userAgents, "ua.md", agentMarkdown({ name: "user-only", description: "user agent" }));
  await writeAgentFile(userAgents, "shared.md", agentMarkdown({ name: "shared", description: "from user" }, "USER PROMPT"));
  await writeAgentFile(projectAgents, "pa.md", agentMarkdown({ name: "project-only", description: "project agent" }));
  await writeAgentFile(projectAgents, "shared.md", agentMarkdown({ name: "shared", description: "from project" }, "PROJECT PROMPT"));

  const userResult = discoverAgents(agentDir, project, "user");
  assert.deepEqual(userResult.agents.map((a) => a.name).sort(), ["shared", "user-only"]);
  assert.equal(userResult.agents.find((a) => a.name === "shared")!.description, "from user");
  assert.equal(userResult.projectAgentsDir, projectAgents);

  const projectResult = discoverAgents(agentDir, project, "project");
  assert.deepEqual(projectResult.agents.map((a) => a.name).sort(), ["project-only", "shared"]);
  assert.equal(projectResult.agents.find((a) => a.name === "shared")!.description, "from project");

  const both = discoverAgents(agentDir, project, "both");
  assert.deepEqual(both.agents.map((a) => a.name).sort(), ["project-only", "shared", "user-only"]);
  const shared = both.agents.find((a) => a.name === "shared")!;
  assert.equal(shared.description, "from project");
  assert.equal(shared.source, "project");
  assert.ok(shared.systemPrompt.includes("PROJECT PROMPT"));
});

test("project agents resolve to the nearest .pi/agents directory", async (t) => {
  const tmp = await makeTempDir("pi-lite-agents-");
  t.after(tmp.cleanup);
  const outerAgents = join(tmp.dir, ".pi", "agents");
  const inner = join(tmp.dir, "project");
  const innerAgents = join(inner, ".pi", "agents");
  const deep = join(inner, "sub", "deep");
  await writeAgentFile(outerAgents, "outer.md", agentMarkdown({ name: "outer", description: "outer" }));
  await writeAgentFile(innerAgents, "inner.md", agentMarkdown({ name: "inner", description: "inner" }));
  await mkdir(deep, { recursive: true });

  const result = discoverAgents(join(tmp.dir, "missing-agent-dir"), deep, "project");
  assert.equal(result.projectAgentsDir, innerAgents);
  assert.deepEqual(result.agents.map((a) => a.name), ["inner"]);
});
