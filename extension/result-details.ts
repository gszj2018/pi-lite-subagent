/** Runtime schemas for subagent result details; static contracts are derived in types.ts. */

import { Type } from "typebox";

export const AgentScopeSchema = Type.Union([
  Type.Literal("user"), Type.Literal("project"), Type.Literal("both"),
]);

export const UsageStatsSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  cost: Type.Number({ minimum: 0 }),
  contextTokens: Type.Number({ minimum: 0 }),
  turns: Type.Number({ minimum: 0 }),
});

export const SingleResultSchema = Type.Object({
  agent: Type.String(),
  agentSource: Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("unknown")]),
  task: Type.String(),
  /** Process exit code; absent or undefined while the task is still running. */
  exitCode: Type.Optional(Type.Integer()),
  messages: Type.Array(Type.Unknown()),
  stderr: Type.String(),
  usage: UsageStatsSchema,
  model: Type.Optional(Type.String()),
  stopReason: Type.Optional(Type.String()),
  errorMessage: Type.Optional(Type.String()),
  step: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const SubagentDetailsSchema = Type.Object({
  mode: Type.Union([Type.Literal("parallel"), Type.Literal("chain")]),
  agentScope: AgentScopeSchema,
  projectAgentsDir: Type.Union([Type.String(), Type.Null()]),
  results: Type.Array(SingleResultSchema),
});
