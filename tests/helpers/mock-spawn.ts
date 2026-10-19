/**
 * Mock child-process spawn for subagent runner tests.
 *
 * A script entry drives one spawned process; the last script is reused for
 * additional calls when fewer scripts than calls are provided. Non-held
 * processes release (feed their output, then close) on a microtask.
 */

import { EventEmitter } from "node:events";
import type { SpawnFunction } from "../../extension/types.ts";

export interface SpawnCall {
  command: string;
  args: string[];
  options: Record<string, unknown>;
}

export interface MockProcScript {
  /** JSON event lines emitted on stdout before close. */
  stdoutLines?: string[];
  /** Text emitted on stderr before close. */
  stderr?: string;
  /** Exit code reported on close (default 0). */
  exitCode?: number;
  /** Keep the process open until released manually. */
  hold?: boolean;
  /** Ignore SIGTERM (only SIGKILL closes the process). */
  ignoreTerm?: boolean;
}

// noinspection JSUnusedGlobalSymbols
export class MockChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: string[] = [];
  killed = false;
  released = false;

  constructor(readonly script: MockProcScript, readonly index: number) {
    super();
  }

  get alive(): boolean {
    return !this.released;
  }

  kill(signal?: string): boolean {
    this.kills.push(String(signal));
    this.killed = true;
    if (this.script.ignoreTerm && signal !== "SIGKILL") return true;
    this.release(null);
    return true;
  }

  /** Feed scripted output, then close, like a real process exit. */
  release(exitCode: number | null = 0): void {
    if (this.released) return;
    this.released = true;
    if (this.script.stderr) this.stderr.emit("data", Buffer.from(this.script.stderr));
    for (const line of this.script.stdoutLines ?? []) {
      this.stdout.emit("data", Buffer.from(`${line}\n`));
    }
    this.emit("close", exitCode);
  }
}

export class MockSpawn {
  readonly calls: SpawnCall[] = [];
  readonly procs: MockChildProcess[] = [];
  private readonly scripts: MockProcScript[];

  constructor(scripts: MockProcScript[] = []) {
    this.scripts = scripts;
  }

  readonly spawn: SpawnFunction = ((command: string, args: string[], options?: Record<string, unknown>) => {
    const index = this.calls.length;
    const script = this.scripts[index] ?? this.scripts[this.scripts.length - 1] ?? {};
    const proc = new MockChildProcess(script, index);
    this.calls.push({ command, args, options: options ?? {} });
    this.procs.push(proc);
    if (!script.hold) queueMicrotask(() => proc.release(script.exitCode ?? 0));
    return proc;
  }) as unknown as SpawnFunction;

  get aliveCount(): number {
    return this.procs.filter((p) => p.alive).length;
  }
}

export interface AssistantMessageOptions {
  usage?: Record<string, unknown>;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function assistantMessage(text: string, options: AssistantMessageOptions = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: options.model,
    stopReason: options.stopReason,
    errorMessage: options.errorMessage,
    usage: options.usage ?? { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 }, totalTokens: 10 },
    timestamp: Date.now(),
  };
}

export function basicUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 }, totalTokens: 100, ...overrides };
}

export function messageEndEvent(message: unknown): string {
  return JSON.stringify({ type: "message_end", message });
}

export function toolResultEvent(text = "tool output"): string {
  return JSON.stringify({
    type: "tool_result_end",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  });
}
