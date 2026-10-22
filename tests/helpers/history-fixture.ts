/** In-memory transcript fixtures, deliberately accepting malformed details for decoder tests. */

export function task(agent = "worker", prompt = "task") {
  return { agent, task: prompt };
}

export function callEntry(id: string, tasks: unknown[] = [task()], mode: "parallel" | "chain" = "parallel") {
  return {
    type: "message", id: `entry-${id}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant", content: [{ type: "toolCall", id, name: "subagent", arguments: { mode, tasks } }],
    },
  };
}

export function singleResult(overrides: Record<string, unknown> = {}) {
  return {
    agent: "worker", agentSource: "user", task: "task", exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: "answer" }] }],
    stderr: "", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, contextTokens: 3 },
    ...overrides,
  };
}

export function resultEntry(
  id: string,
  results: unknown[] = [singleResult()],
  options: { mode?: "parallel" | "chain"; isError?: boolean; text?: string; details?: unknown } = {},
) {
  return {
    type: "message", id: `result-${id}`, parentId: `entry-${id}`, timestamp: "2026-01-01T00:01:00.000Z",
    message: {
      role: "toolResult", toolName: "subagent", toolCallId: id, isError: options.isError ?? false,
      content: [{ type: "text", text: options.text ?? "call output" }],
      details: "details" in options ? options.details : {
        mode: options.mode ?? "parallel", agentScope: "user", projectAgentsDir: null, results,
      },
    },
  };
}
