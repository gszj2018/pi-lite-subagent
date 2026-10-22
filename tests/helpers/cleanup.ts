/**
 * Cleanup helpers for test-created temp artifacts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Delete one truncation temp file, then remove its directory non-recursively.
 * A wrong or unexpected path can never wipe a directory tree: rmdir fails on a
 * non-empty directory instead of deleting its contents.
 */
export async function removeTruncationArtifact(filePath: string): Promise<void> {
  await fs.promises.rm(filePath, { force: true });
  await fs.promises.rmdir(path.dirname(filePath));
}

/** Reset this extension's process-local shared state between tests; leave env and session files untouched. */
export function clearSharedState(): void {
  delete globalThis.__github_gszj2018_piLiteSubagent_sharedState;
}
