/** Sessions live under an isolated agentDir, alongside a sibling projectDir, in one self-cleaning temp tree. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { subagentSessionDir } from "../../extension/session-paths.ts";
import { makeTempDir } from "./agents-fixture.ts";

export const SESSION_TIME = "2026-10-20T10:00:00.000Z";

export function sessionText(id: string, cwd: string, options: {
  agent?: string; timestamp?: string; extra?: unknown[];
} = {}): string {
  const timestamp = options.timestamp ?? SESSION_TIME;
  const entries: unknown[] = [{ type: "session", version: 3, id, timestamp, cwd }];
  if (options.agent !== undefined) entries.push({
    type: "custom", id: "marker", parentId: null, timestamp,
    customType: "active_agent", data: { name: options.agent },
  });
  entries.push(...(options.extra ?? []));
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

export async function withTempSessions(t: TestContext) {
  const tmp = await makeTempDir("pi-lite-sessions-");
  t.after(tmp.cleanup);
  const baseDir = await fs.realpath(tmp.dir);
  const agentDir = path.join(baseDir, "agent-dir");
  const projectDir = path.join(baseDir, "project");
  const sessionDir = path.join(agentDir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(projectDir);
  const parent = { file: path.join(sessionDir, "parent.jsonl"), id: "parent" };
  await fs.writeFile(parent.file, sessionText(parent.id, projectDir));
  const child = async (owner = parent, id = "child", options: Parameters<typeof sessionText>[2] = {}) => {
    const directory = subagentSessionDir(path.dirname(owner.file), owner.id)!;
    await fs.mkdir(directory, { recursive: true });
    const identity = { file: path.join(directory, `${id}.jsonl`), id };
    await fs.writeFile(identity.file, sessionText(id, projectDir, options));
    return identity;
  };
  return { agentDir, projectDir, sessionDir, parent, child };
}
