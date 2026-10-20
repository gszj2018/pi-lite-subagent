# pi-lite-subagent

English | [简体中文](./README.zh-CN.md)

A lightweight [Pi Coding Agent](https://github.com/earendil-works/pi) extension that delegates work to **subagents running in
separate `pi` processes**, so each task gets an isolated context. Tasks can be dispatched in parallel or chained, and every
agent is defined by a plain Markdown file.

## Features

- **Isolated contexts** — each task runs in its own `pi` child process, so intermediate tool output never pollutes the parent
  conversation.
- **Two dispatch modes** — `parallel` (up to 4 concurrent tasks) and `chain` (sequential, piping output with a `{previous}`
  placeholder).
- **Markdown agent definitions** — describe an agent with YAML frontmatter plus a system prompt body.
- **Per-agent model and thinking level** — set them on the agent, or fall back to the dispatching session.
- **Session persistence** — each subagent run's session file is stored in its own subdirectory of the parent session directory and
  can be opened later, read-only.
- **Bounded output** — oversized subagent output is truncated in the conversation and saved in full to a temp file.
- **No nesting** — subagent processes do not expose the `subagent` tool.

## Installation

Install as a Pi package:

```bash
# From npm
pi install npm:pi-lite-subagent

# From this GitHub repository
pi install git:github.com/gszj2018/pi-lite-subagent
```

The package registers a single tool named `subagent` and adds no commands or configuration files.

## Usage

### Defining Agents

An agent is a Markdown file: YAML frontmatter describes it, the body becomes its system prompt.

```markdown
---
name: code-reviewer
description: Reviews code changes for bugs and style issues
tools: read, grep, bash
model: deepseek/deepseek-flash
thinking: high
---

You are a meticulous code reviewer. Report concrete problems with file paths and line numbers.
```

Agents are discovered from two locations:

| Scope     | Directory                                                          |
|-----------|--------------------------------------------------------------------|
| `user`    | `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`)          |
| `project` | the nearest `.pi/agents/` found from the current directory upwards |

The extension ships no preset agent definitions; create the `.md` files yourself in one of the directories above. `tasks` can only
reference agent names that exist there.

Frontmatter fields:

| Field         | Required | Description                                                                                                                                              |
|---------------|----------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| `name`        | yes      | Agent name used by the `subagent` tool.                                                                                                                  |
| `description` | yes      | Short description of what the agent is for.                                                                                                              |
| `tools`       | no       | Comma-separated string or list of tool names. Omitted means no tool restriction is passed to the subagent.                                               |
| `model`       | no       | Model as `provider/id`. Omitted means the dispatching session's model is used.                                                                           |
| `thinking`    | no       | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Omitted means the dispatching session's level is used when no `model` is set. |

Files without `name` or `description` are skipped. A malformed file never breaks the rest of the directory.

### Dispatching Tasks

The `subagent` tool takes a task list and an optional mode:

| Parameter    | Type                                | Default    | Description                                                             |
|--------------|-------------------------------------|------------|-------------------------------------------------------------------------|
| `tasks`      | `{ agent, task }[]`                 | (required) | 1–8 subtasks; `agent` is a discovered agent name, `task` is the prompt. |
| `mode`       | `"parallel"` \| `"chain"`           | `parallel` | How the task list is executed.                                          |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | `user`     | Which agent directories to read.                                        |

**Parallel** — up to 4 tasks run at once; results come back as one `### [agent] status` section per task.

```json
{
  "mode": "parallel",
  "tasks": [
    { "agent": "code-reviewer", "task": "Review the changes in extension/run-agent.ts." },
    { "agent": "doc-writer", "task": "Update README usage examples." }
  ]
}
```

**Chain** — tasks run one after another; `{previous}` in a task is replaced with the previous step's final output. The chain
stops at the first failing step and returns that step's error output.

```json
{
  "mode": "chain",
  "tasks": [
    { "agent": "code-explorer", "task": "Summarize how session persistence works." },
    { "agent": "doc-writer", "task": "Turn this into a README section:\n{previous}" }
  ]
}
```

A single task behaves identically in both modes, so `mode` can be omitted for one-off delegation.

### Project Agents and Trust

`agentScope: "project"` or `"both"` only works in a **trusted** project. In an untrusted project the tool returns an error
without starting any subprocess. The default scope `user` is unaffected by project trust.

With `agentScope: "both"`, a project agent overrides a user agent of the same name.

### Model and Thinking Resolution

| Agent defines         | Model used                     | Thinking level passed              |
|-----------------------|--------------------------------|------------------------------------|
| `model` + `thinking`  | agent `model`                  | agent `thinking`                   |
| `model` only          | agent `model`                  | none (model default)               |
| `thinking` only       | dispatching session's model    | agent `thinking`                   |
| neither               | dispatching session's model    | dispatching session's level        |

### Sessions and File Access

Each subagent runs as its own `pi` process, in the parent session's working directory. There is no `cwd` parameter.

When the parent session is persisted, each subagent run writes its own session file under
`<parent session dir>/lite-subagent/<parent session id>/`. Those files stay out of the normal session list; open one explicitly
with `pi --session <path>`. If the parent session is not persisted, or the directory cannot be created, the child runs with
`--no-session`.

Opened subagent sessions are **inspection only**: sending a prompt is rejected with a notification. Slash commands such as `/quit`
still work.

### Output Size

Subagent output shown to the model is capped at the host defaults (2000 lines / 50 KB, whichever comes first). When output
exceeds the cap, the visible part is followed by a hint with the line/byte counts and the path of a temp file containing the
full output, which the model can read with the `read` tool. Temp files are not deleted automatically.

## Environment Variables

The extension sets these variables for its own child processes and recognizes them in return:

| Variable                     | Meaning                                                                                                                    |
|------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `PI_SUBAGENT_DEPTH`          | Depth of the current process. Absent in the root session; `1` in a subagent process.                                       |
| `PI_SUBAGENT_NAME`           | Agent name of the current subagent session.                                                                                |
| `PI_SUBAGENT_PARENT_SESSION` | Session ID of the root session, set at `session_start` and removed at `session_shutdown`; inherited unchanged by children. |

`PI_SUBAGENT_PARENT_SESSION` follows the convention used by
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system), so permission
asks from a subagent can be routed back to the parent session. A subagent process never overwrites that pointer.

## Notes and Limitations

- **No nested subagents.** Depth is limited to one level (hard-coded, not configurable); subagent processes do not register the
  `subagent` tool.
- **No retries.** A failed chain step aborts the remaining steps; individual tasks are not retried.
- **Task limit.** At most 8 tasks per call; at most 4 run concurrently in `parallel`.
- **Inherited extensions.** Child processes inherit the parent's `--extension`/`-e` and `--no-extensions`/`-ne` arguments, so
  extensions loaded manually on the command line are also available to subagents.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type-check
npm run typecheck
```

To load the extension locally without packaging, run pi from the repository root:

```bash
pi -e ./extension/index.ts
```

The project is written in TypeScript and uses the Node.js built-in test runner.

## Project Structure

```text
pi-lite-subagent/
├── extension/
│   ├── index.ts          # Extension entry point (dependency assembly only)
│   ├── agents.ts         # Agent discovery and frontmatter parsing
│   ├── env-vars.ts       # PI_SUBAGENT_* variables, depth gating, child environment
│   ├── run-agent.ts      # pi invocation, child process, JSON event stream
│   ├── truncation.ts     # Output truncation and temp-file spill
│   ├── active-agent.ts   # Subagent session marker, renderer, read-only guard
│   ├── subagent-tool.ts  # The subagent tool: parameters, dispatch, rendering
│   └── types.ts          # Shared interfaces and result types
└── tests/                # Unit and integration tests
```

## Credits

The agent-discovery, process-invocation, and rendering logic derives from the
[subagent example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent) shipped with
Pi Coding Agent, substantially reorganized and extended. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## License

[MIT](./LICENSE)
