/**
 * Shared dependency-injection, subagent-result and inspection-navigation contracts.
 *
 * Only true system boundaries are injected here (`process.env`, process spawn);
 * Node built-ins (`node:fs`, `node:os`) are used directly and are not abstracted.
 */

import type { spawn } from "node:child_process";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Compatible with `node:child_process.spawn`; index.ts injects the real implementation, tests inject a mock. */
export type SpawnFunction = typeof spawn;

/** Mutable environment-variable view; index.ts passes `process.env`, tests pass a plain object. */
export type ProcessEnvLike = Record<string, string | undefined>;

/**
 * Cached parse of the parent process's extension-loading CLI arguments.
 * Parsed once in the factory and consumed on every spawn.
 */
export interface InheritedExtensionArgs {
  /** Extension paths in appearance order (from the parent's `--extension`/`-e`). */
  extensions: readonly string[];
  /** Whether the parent carried `--no-extensions`/`-ne`. */
  noExtensions: boolean;
}

/**
 * Inputs for resolving the `pi` invocation, assembled in the factory
 * (`process.execPath` / `process.argv[1]`) so runners never read process state.
 */
export interface PiLaunchInfo {
  /** Runtime executable path (`process.execPath`) for launching the pi script. */
  execPath: string;
  /** Path of the currently running pi script (`process.argv[1]`), when available. */
  piScriptPath?: string;
}

/** Runtime dependencies for the extension (tool registration and runner). */
export interface SubagentRunnerDeps {
  spawn: SpawnFunction;
  /** Base environment variables (usually `process.env`); copied when building the child env. */
  env: ProcessEnvLike;
  /** User agent directory (`getAgentDir()`); the "user" agents live in `<agentDir>/agents`. */
  agentDir: string;
  /** pi launch info assembled in the factory; consumed by getPiInvocation. */
  piLaunch: PiLaunchInfo;
  /** Extension-loading arguments parsed and cached once in the factory; consumed on spawn. */
  extensionArgs: InheritedExtensionArgs;
}

/** Dispatch-time defaults inherited by agents without their own configuration. */
export interface DispatchDefaults {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/** Aggregated token/cost statistics across a subagent run. */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Full result of one subagent run; kept complete even when model-facing text is truncated. */
export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  /** Process exit code; `undefined` while the task is still running. */
  exitCode: number | undefined;
  messages: unknown[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export type AgentScope = "user" | "project" | "both";

/** Structured details attached to the tool result, used for TUI rendering and state reconstruction. */
export interface SubagentDetails {
  mode: "parallel" | "chain";
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

/** Streaming update callback for a running tool call. */
export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** An uncommitted switch; its object identity prevents stale operations from rolling back a newer switch. */
export interface NavigationPending {
  /** Entering a child pushes a frame; returning to its parent pops one. */
  operation: "push" | "pop";
  /** Canonical file path of the session active when the switch was requested. */
  from: string;
  /** Canonical file path of the session whose startup commits the operation. */
  to: string;
}

/** Mutable in-process navigation state shared across extension-runtime replacements. */
export interface NavigationState {
  /** Canonical parent session-file paths, ordered outermost to nearest and updated in place. */
  frames: string[];
  /** Switch awaiting startup reconciliation; committed frames remain unchanged until then. */
  pending?: NavigationPending;
}
