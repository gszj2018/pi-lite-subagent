/** Shared persistence paths; these helpers never create directories. */

import * as path from "node:path";

export function isPathSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

export function subagentSessionDir(sessionDir: string, sessionId: string): string | undefined {
  return sessionDir !== "" && isPathSafeSessionId(sessionId)
    ? path.join(sessionDir, "lite-subagent", sessionId) : undefined;
}

/** Compare session-file paths using the platform's path rules, including Windows case handling. */
export function sameSessionFile(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

