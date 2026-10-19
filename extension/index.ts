/**
 * Extension entry point: the default factory only.
 *
 * The factory performs the one-time parse of the parent CLI arguments (cached
 * as InheritedExtensionArgs), resolves the user agent directory, assembles the
 * real system dependencies, and registers all modules inline. Tests never
 * import this entry module; they assemble registrations themselves with fake
 * dependencies.
 */

import { spawn } from "node:child_process";
import { type ExtensionAPI, getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";
import { registerActiveAgentMarker } from "./active-agent.ts";
import { isSubagentToolAllowed, registerSessionEnv } from "./env-vars.ts";
import { registerSubagentTool } from "./subagent-tool.ts";
import type { SubagentRunnerDeps } from "./types.ts";

export default function setup(pi: ExtensionAPI): void {
  const parsed = parseArgs(process.argv.slice(2));
  const deps: SubagentRunnerDeps = {
    spawn,
    env: process.env,
    agentDir: getAgentDir(),
    piLaunch: { execPath: process.execPath, piScriptPath: process.argv[1] },
    extensionArgs: {
      extensions: [...(parsed.extensions ?? [])],
      noExtensions: parsed.noExtensions ?? false,
    },
  };
  registerSessionEnv(pi, deps.env);
  registerActiveAgentMarker(pi, deps.env);
  if (isSubagentToolAllowed(deps.env)) {
    // Subagent sessions are leaf nodes and never register the tool.
    registerSubagentTool(pi, deps);
  }
}
