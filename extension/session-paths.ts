/** Shared persistence paths; these helpers never create directories. */

import * as path from "node:path";

export function isPathSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

export function subagentSessionDir(sessionDir: string, sessionId: string): string | undefined {
  return sessionDir !== "" && isPathSafeSessionId(sessionId)
    ? path.join(sessionDir, "lite-subagent", sessionId) : undefined;
}

export interface SessionIdentity {
  file: string;
  id: string;
}

export function sameSession(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.id === b.id && path.relative(a.file, b.file) === "";
}

export function isInsideDirectory(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
