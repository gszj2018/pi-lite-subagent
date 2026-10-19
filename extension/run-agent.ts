/**
 * Subagent child-process runner.
 *
 * Resolves the `pi` invocation, builds the CLI argument list (pure function),
 * and runs a single agent against the JSON event stream on stdout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { buildChildEnv } from "./env-vars.ts";
import type {
  DispatchDefaults,
  InheritedExtensionArgs,
  OnUpdateCallback,
  PiLaunchInfo,
  SingleResult,
  SubagentDetails,
  SubagentRunnerDeps,
  UsageStats,
} from "./types.ts";

export function emptyUsageStats(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function getFinalOutput(messages: SingleResult["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  if (result.state.status !== "exited") return false;
  return result.state.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

export interface PiInvocationInput extends PiLaunchInfo {
  /** CLI arguments for the pi run. */
  args: string[];
}

/**
 * Resolve how to invoke pi for a subagent run. All process-level values arrive
 * through the input (assembled in the factory); only the script-existence check
 * touches the file system.
 */
export function getPiInvocation(input: PiInvocationInput): { command: string; args: string[] } {
  const { execPath, piScriptPath, args } = input;
  const isBunVirtualScript = piScriptPath?.startsWith("/$bunfs/root/");
  if (piScriptPath && !isBunVirtualScript && fs.existsSync(piScriptPath)) {
    return { command: execPath, args: [piScriptPath, ...args] };
  }

  const execName = path.basename(execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: execPath, args };
  }

  return { command: "pi", args };
}

/** Where a subagent run persists its session: a dedicated directory, or none. */
export type SessionConfig = { mode: "persist"; dir: string } | { mode: "no-session" };

/** Whether a session id is safe to use as a path component and CLI argument. */
export function isPathSafeSessionId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function tryEnsureDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide where the subagent's session files go: a dedicated directory under the
 * parent session dir, or no persistence at all (missing dir, unsafe session id,
 * or a directory that cannot be created).
 */
function resolveSessionConfig(ctx: ExtensionContext): SessionConfig {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  if (sessionDir !== "" && isPathSafeSessionId(sessionId)) {
    const dir = path.join(sessionDir, "lite-subagent", sessionId);
    if (tryEnsureDir(dir)) return { mode: "persist", dir };
  }
  return { mode: "no-session" };
}

export interface BuildPiArgsInput {
  /** Agent definition: tools/model/thinking configuration source. */
  agent: AgentConfig;
  /** Task text (emitted as the trailing `Task: <task>` positional). */
  task: string;
  /** Dispatch-side model inherited when the agent defines no `model`. */
  dispatchModel?: string;
  /** Dispatch-side thinking level, inherited only when the agent defines neither `model` nor `thinking`. */
  dispatchThinking?: ThinkingLevel;
  /** Path of the temp file holding the agent's system prompt (written by the caller). */
  promptFilePath?: string;
  /** Session persistence policy for the subagent process (defaults to no-session). */
  session?: SessionConfig;
  /** Extension-loading arguments cached in the factory. */
  extensionArgs: InheritedExtensionArgs;
}

/**
 * Build the `pi` CLI argument list for one subagent run (pure function).
 *
 * Emission order: inherited extension flags first (short forms),
 * then `--mode json -p` with the session policy, model/thinking/tools options,
 * the system-prompt file, and the trailing task positional.
 */
export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const args: string[] = [];
  const { extensionArgs } = input;
  if (extensionArgs.noExtensions) args.push("-ne");
  for (const extension of extensionArgs.extensions) args.push("-e", extension);

  args.push("--mode", "json", "-p");

  const session = input.session ?? { mode: "no-session" };
  if (session.mode === "persist") args.push("--session-dir", session.dir);
  else args.push("--no-session");

  const model = input.agent.model ?? input.dispatchModel;
  if (model) args.push("--model", model);

  // An explicit `thinking` field always wins; otherwise the dispatch level is
  // inherited only by agents without their own `model`.
  const thinking = input.agent.thinking ?? (!input.agent.model ? input.dispatchThinking : undefined);
  if (thinking) args.push("--thinking", thinking);

  if (input.agent.tools && input.agent.tools.length > 0) args.push("--tools", input.agent.tools.join(","));
  if (input.promptFilePath) args.push("--append-system-prompt", input.promptFilePath);

  args.push(`Task: ${input.task}`);
  return args;
}

export interface RunSingleAgentOptions {
  deps: SubagentRunnerDeps;
  /** Session context: provides the working directory (and later session persistence info). */
  ctx: ExtensionContext;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  dispatchDefaults: DispatchDefaults;
  step?: number;
  signal?: AbortSignal | undefined;
  onUpdate?: OnUpdateCallback | undefined;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

export async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
  const { deps, ctx, agents, agentName, task, dispatchDefaults, step, signal, onUpdate, makeDetails } = options;
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      state: { status: "exited", exitCode: 1 },
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsageStats(),
      step,
    };
  }

  const model = agent.model ?? dispatchDefaults.model;
  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    state: { status: "running" },
    messages: [],
    stderr: "",
    usage: emptyUsageStats(),
    model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const args = buildPiArgs({
      agent,
      task,
      session: resolveSessionConfig(ctx),
      dispatchModel: dispatchDefaults.model,
      dispatchThinking: dispatchDefaults.thinkingLevel,
      promptFilePath: tmpPromptPath ?? undefined,
      extensionArgs: deps.extensionArgs,
    });

    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation({ ...deps.piLaunch, args });
      const proc = deps.spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildChildEnv(deps.env, agent.name),
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message);
          emitUpdate();
        }
      };

      proc.stdout?.on("data", (data: Buffer | string) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr?.on("data", (data: Buffer | string) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        // `proc.killed` becomes true as soon as kill() is called, so track
        // process closure independently for the SIGKILL escalation.
        let closed = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        proc.on("close", () => {
          closed = true;
          if (killTimer !== undefined) clearTimeout(killTimer);
        });
        const killProc = () => {
          wasAborted = true;
          // Schedule the escalation before killing: a process that closes
          // synchronously must still see a registered timer to clear.
          killTimer = setTimeout(() => {
            if (!closed) proc.kill("SIGKILL");
          }, 5000);
          proc.kill("SIGTERM");
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });
    currentResult.state = { status: "exited", exitCode };
    if (wasAborted) throw new Error("Subagent was aborted");
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
