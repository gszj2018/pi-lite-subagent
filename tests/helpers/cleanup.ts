/**
 * Cleanup helpers for test-created temp artifacts.
 */

import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Delete one truncation temp file, then remove its directory non-recursively.
 * A wrong or unexpected path can never wipe a directory tree: rmdir fails on a
 * non-empty directory instead of deleting its contents.
 */
export async function removeTruncationArtifact(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rmdir(dirname(filePath));
}
