/** Persisted-session fixtures stay inside one self-cleaning temporary directory. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TestContext } from "node:test";
import { subagentSessionDir, type SessionIdentity } from "../../extension/session-paths.ts";
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
  const cwd = await fs.realpath(tmp.dir);
  const root = path.join(cwd, "sessions");
  await fs.mkdir(root);
  const parent: SessionIdentity = { file: path.join(root, "parent.jsonl"), id: "parent" };
  await fs.writeFile(parent.file, sessionText(parent.id, cwd));
  const child = async (owner = parent, id = "child", options: Parameters<typeof sessionText>[2] = {}) => {
    const directory = subagentSessionDir(path.dirname(owner.file), owner.id)!;
    await fs.mkdir(directory, { recursive: true });
    const identity = { file: path.join(directory, `${id}.jsonl`), id };
    await fs.writeFile(identity.file, sessionText(id, cwd, options));
    return identity;
  };
  return { cwd, root, parent, child };
}
