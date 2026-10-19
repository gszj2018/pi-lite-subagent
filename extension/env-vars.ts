/**
 * Subagent environment variables shared with sibling integrations
 * (e.g. `@gotgenes/pi-permission-system` parent-session forwarding).
 *
 * - `PI_SUBAGENT_PARENT_SESSION`: session id of the parent (root) session. Written by
 *   `session_start` in root sessions, removed again at `session_shutdown`; inherited
 *   unchanged by child processes.
 * - `PI_SUBAGENT_DEPTH`: depth of the current process. Absent (or invalid) means the
 *   parent session (depth 0); no code path may ever write "0".
 * - `PI_SUBAGENT_NAME`: agent name of the subagent owning the current process; written
 *   only into the child-process environment at spawn time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessEnvLike } from "./types.ts";

export const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
export const DEPTH_ENV = "PI_SUBAGENT_DEPTH";
export const NAME_ENV = "PI_SUBAGENT_NAME";
export const MAX_SUBAGENT_DEPTH = 1; // hard-coded; not configurable yet

/**
 * Valid depth: an integer string >= 1 after trimming. Anything else
 * (undefined/empty/"0"/negative/decimal/non-numeric) is treated as absent.
 */
export function parseSubagentDepth(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const depth = Number(trimmed);
  return Number.isSafeInteger(depth) && depth >= 1 ? depth : undefined;
}

/** Whether the current session runs inside a subagent process (valid depth >= 1). */
export function isSubagentSession(env: ProcessEnvLike): boolean {
  return parseSubagentDepth(env[DEPTH_ENV]) !== undefined;
}

/** Whether the `subagent` tool may be registered: depths at or beyond the limit stay leaf nodes. */
export function isSubagentToolAllowed(env: ProcessEnvLike): boolean {
  return (parseSubagentDepth(env[DEPTH_ENV]) ?? 0) < MAX_SUBAGENT_DEPTH;
}

/**
 * Build the child-process environment for a subagent run: the base environment with
 * `PI_SUBAGENT_DEPTH` bumped by one (always >= 1) and `PI_SUBAGENT_NAME` set to the agent
 * name. `PI_SUBAGENT_PARENT_SESSION` is inherited unchanged. The base is not mutated.
 */
export function buildChildEnv(base: ProcessEnvLike, agentName: string): ProcessEnvLike {
  const depth = parseSubagentDepth(base[DEPTH_ENV]) ?? 0;
  return {
    ...base,
    [DEPTH_ENV]: String(depth + 1),
    [NAME_ENV]: agentName,
  };
}

/**
 * Register session-level management of `PI_SUBAGENT_PARENT_SESSION` (all modes).
 * Root sessions record their session id at `session_start` and clean up at
 * `session_shutdown`; subagent sessions keep the inherited pointer untouched —
 * rewriting it would break real parent-session forwarding.
 */
export function registerSessionEnv(pi: ExtensionAPI, env: ProcessEnvLike): void {
  let setByUs = false;

  pi.on("session_start", (_event, ctx) => {
    if (isSubagentSession(env)) return;
    let id: unknown;
    try {
      id = ctx.sessionManager.getSessionId();
    } catch {
      id = undefined;
    }
    if (typeof id === "string" && id.trim() !== "") {
      env[PARENT_SESSION_ENV] = id;
      setByUs = true;
    } else {
      ctx.ui.notify("lite-subagent: cannot record the parent session id.", "error");
    }
  });

  pi.on("session_shutdown", () => {
    if (!setByUs) return;
    delete env[PARENT_SESSION_ENV];
    setByUs = false;
  });
}
