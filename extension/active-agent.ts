/**
 * Session entry marker ("active_agent") identifying subagent sessions.
 *
 * A custom entry is appended once per subagent session so the session file
 * itself carries the marker: resuming the session, or opening its file from
 * another session, keeps it inspection-only and renders a prominent header.
 */

import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { getSubagentName, isSubagentSession } from "./env-vars.ts";
import type { ProcessEnvLike } from "./types.ts";

/** Custom entry type marking a session as a subagent session. */
export const ACTIVE_AGENT_ENTRY_TYPE = "active_agent";

export interface ActiveAgentEntryData {
  name: string;
}

export function registerActiveAgentMarker(pi: ExtensionAPI, env: ProcessEnvLike): void {
  let hasActiveAgentEntry = false;

  // Registered unconditionally: opening a subagent session file from another
  // session must render the marker too; headless modes never call the renderer.
  pi.registerEntryRenderer<ActiveAgentEntryData>(ACTIVE_AGENT_ENTRY_TYPE, (entry, _options, theme) => {
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    const name = entry.data?.name ?? "unknown";
    box.addChild(new Text(`${theme.fg("accent", `${theme.bold("Subagent session")} (inspection only) ·`)} ${name}`, 0, 0));
    return box;
  });

  // The scan always runs and sets the flag explicitly to the scan result, so a
  // stale value never leaks into a switched-to session.
  pi.on("session_start", (_event, ctx) => {
    hasActiveAgentEntry = ctx.sessionManager
      .getEntries()
      .some((entry) => entry.type === "custom" && entry.customType === ACTIVE_AGENT_ENTRY_TYPE);
  });

  // Appending happens only inside subagent sessions, and only once per session.
  pi.on("before_agent_start", () => {
    if (hasActiveAgentEntry) return;
    if (!isSubagentSession(env)) return;
    const name = getSubagentName(env);
    if (name === undefined) return;
    pi.appendEntry<ActiveAgentEntryData>(ACTIVE_AGENT_ENTRY_TYPE, { name });
    hasActiveAgentEntry = true;
  });

  // Inspection-only: prompts in a session carrying the marker are blocked.
  pi.on("input", (_event, ctx) => {
    if (!hasActiveAgentEntry) return undefined;
    ctx.ui.notify("This is a subagent session (inspection only); prompts cannot be sent here.", "error");
    const result: InputEventResult = { action: "handled" };
    return result;
  });
}
