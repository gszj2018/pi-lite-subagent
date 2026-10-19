/**
 * Temp-directory fixtures for agent discovery and tool tests.
 *
 * Tests always use real temp directories and clean up after themselves; the
 * user agent directory is isolated by passing the fixture's `agentDir`
 * explicitly to the functions under test (never through the environment).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TempDir {
  dir: string;
  cleanup(): Promise<void>;
}

export async function makeTempDir(prefix: string): Promise<TempDir> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
}

export async function writeAgentFile(dir: string, fileName: string, content: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, fileName), content, "utf-8");
}

export interface AgentFileFields {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  thinking?: string;
}

/** Build an agent markdown file; omitted fields are left out of the frontmatter entirely. */
export function agentMarkdown(fields: AgentFileFields, body = "System prompt body."): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", body);
  return lines.join("\n");
}
