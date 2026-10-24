# pi-lite-subagent

[English](./README.md) | 简体中文

本扩展为 [Pi Coding Agent](https://github.com/earendil-works/pi) 提供轻量级的子智能体委派能力：把任务交给运行在独立 `pi`
子进程中的子智能体完成，使每个任务拥有隔离的上下文。任务可并行执行或串行串联，每个智能体由一个普通 Markdown 文件定义。

## 功能

- **隔离上下文** — 每个任务在自己的 `pi` 子进程中运行，中间工具输出不会污染父会话。
- **两种调度模式** — `parallel`（最多 4 个任务并发）与 `chain`（顺序执行，用 `{previous}` 占位符传递上一步输出）。
- **Markdown 定义智能体** — YAML frontmatter 描述配置，正文即系统提示词。
- **按智能体指定模型与思考强度** — 也可回退到调度方会话的设置。
- **会话持久化** — 每次子智能体运行的会话文件保存在父会话目录下的独立子目录中，之后可只读打开。
- **输出受控** — 超长输出在对话中截断，完整内容写入临时文件。
- **不支持嵌套** — 子智能体进程中不提供 `subagent` 工具。

## 安装

作为 Pi 包安装：

```bash
# 从 npm 安装
pi install npm:pi-lite-subagent

# 从本 GitHub 仓库安装
pi install git:github.com/gszj2018/pi-lite-subagent
```

本扩展注册一个名为 `subagent` 的工具和四个 TUI slash 命令（见下文），不添加配置文件。

## 使用

### 定义智能体

一个智能体就是一个 Markdown 文件：YAML frontmatter 描述配置，正文作为它的系统提示词。

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

智能体从两个位置发现：

| 作用域    | 目录                                                       |
|-----------|------------------------------------------------------------|
| `user`    | `~/.pi/agent/agents/`（或 `$PI_CODING_AGENT_DIR/agents/`） |
| `project` | 从当前目录向上查找到的最近一个 `.pi/agents/`               |

本扩展不自带任何预置智能体定义，需要你在上述目录中自行创建 `.md` 文件；`tasks` 中的 `agent` 只能引用这些已存在的智能体。

frontmatter 字段：

| 字段          | 必填 | 说明                                                                                                                    |
|---------------|------|-------------------------------------------------------------------------------------------------------------------------|
| `name`        | 是   | `subagent` 工具使用的智能体名称。                                                                                       |
| `description` | 是   | 该智能体用途的简短描述。                                                                                                |
| `tools`       | 否   | 逗号分隔的字符串或列表形式的工具名。省略时不向子智能体传递任何工具限制。                                                |
| `model`       | 否   | `provider/id` 形式的模型标识。省略时使用调度方会话的模型。                                                              |
| `thinking`    | 否   | 思考强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。省略时若未设置 `model`，使用调度方会话的思考强度。 |

缺少 `name` 或 `description` 的文件会被跳过；单个文件格式错误不会影响同目录下的其它智能体。

### 派发任务

`subagent` 工具接收一个任务列表以及可选模式：

| 参数         | 类型                                | 默认值     | 说明                                                        |
|--------------|-------------------------------------|------------|-------------------------------------------------------------|
| `tasks`      | `{ agent, task }[]`                 | （必填）   | 1–8 个子任务；`agent` 为已发现的智能体名，`task` 为提示词。 |
| `mode`       | `"parallel"` \| `"chain"`           | `parallel` | 任务列表的执行方式。                                        |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | `user`     | 读取哪些智能体目录。                                        |

**并行（parallel）** — 最多 4 个任务同时运行；结果为每个任务一个 `### [agent] status` 小节。

```json
{
  "mode": "parallel",
  "tasks": [
    { "agent": "code-reviewer", "task": "Review the changes in extension/run-agent.ts." },
    { "agent": "doc-writer", "task": "Update README usage examples." }
  ]
}
```

**串联（chain）** — 任务依次执行，任务中的 `{previous}` 会替换为前一步的最终输出。任一步失败即停止，并返回该步骤的错误输出。

```json
{
  "mode": "chain",
  "tasks": [
    { "agent": "code-explorer", "task": "Summarize how session persistence works." },
    { "agent": "doc-writer", "task": "Turn this into a README section:\n{previous}" }
  ]
}
```

单个任务在两种模式下行为一致，因此一次性委派可以省略 `mode`。

### 项目级智能体与信任

`agentScope: "project"` 或 `"both"` 只在**受信任**的项目中生效。项目未受信任时，工具直接返回错误且不启动任何子进程；默认作用域
`user` 不受项目信任影响。

使用 `agentScope: "both"` 时，同名的项目智能体会覆盖用户级智能体。

### 模型与思考强度取值

| 智能体中的设置        | 使用的模型        | 传入的思考强度              |
|-----------------------|-------------------|-----------------------------|
| `model` + `thinking`  | 智能体的 `model`  | 智能体的 `thinking`         |
| 仅 `model`            | 智能体的 `model`  | 不传（使用模型默认值）      |
| 仅 `thinking`         | 调度方会话的模型  | 智能体的 `thinking`         |
| 都未设置              | 调度方会话的模型  | 调度方会话的思考强度        |

### 命令

仅在 TUI 下可用：

| 命令                          | 功能                                                     |
|-------------------------------|----------------------------------------------------------|
| `/list-subagents`             | 浏览用户级与项目级目录中发现的智能体定义。               |
| `/view-subagents`             | 浏览当前分支的 subagent 任务、状态与结果。               |
| `/switch-to-subagent-session` | 打开当前会话持久化的子智能体会话。                       |
| `/return-to-parent-session`   | 返回上一级会话。                                         |

两个浏览命令在任务运行中也可使用；会话跳转要求会话空闲且无排队消息。

### 会话与文件访问

每个子智能体作为独立的 `pi` 进程运行，工作目录等于父会话的工作目录；工具没有 `cwd` 参数。

父会话持久化时，每次子智能体运行都在 `<父会话目录>/lite-subagent/<父会话 ID>/` 下写入各自的会话文件。这些文件不会出现在常规会话列表中，可用
`pi --session <path>` 或当前会话中的 `/switch-to-subagent-session` 显式打开。若父会话未持久化，或目录无法创建，子进程以 `--no-session` 运行。

被打开的子会话是**只读的**：发送提示词会被拒绝并给出提示，`/quit` 等 slash 命令仍可正常使用。通过
`/switch-to-subagent-session` 打开的子会话可用 `/return-to-parent-session` 返回。

### 输出大小

返回给模型的子智能体输出按宿主默认上限截断（2000 行 / 50 KB，先到先限）。超过上限时，可见部分之后会附加提示，包含行数/字节统计以及保存完整输出的临时文件路径，模型可用
`read` 工具读取剩余内容。临时文件不会自动删除。

## 环境变量

本扩展为自己的子进程设置以下变量，并在自身运行环境中识别它们：

| 变量                         | 含义                                                                                |
|------------------------------|-------------------------------------------------------------------------------------|
| `PI_SUBAGENT_DEPTH`          | 当前进程的深度。根会话中不存在；子智能体进程中为 `1`。                              |
| `PI_SUBAGENT_NAME`           | 当前子智能体会话对应的智能体名称。                                                  |
| `PI_SUBAGENT_PARENT_SESSION` | 根会话的会话 ID，在 `session_start` 写入、`session_shutdown` 移除；子进程原样继承。 |

`PI_SUBAGENT_PARENT_SESSION` 遵循
[`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) 的约定，使子智能体的权限请求可以回到父会话处理。子智能体进程不会覆写该指针。

## 注意事项与限制

- **不支持嵌套子智能体。** 深度上限为 1 层（硬编码，不可配置）；子智能体进程中不会注册 `subagent` 工具。
- **没有重试。** chain 中某一步失败即中止后续步骤；单个任务不会重试。
- **任务数量上限。** 每次调用最多 8 个任务；`parallel` 模式下最多 4 个并发。
- **继承扩展。** 子进程继承父进程的 `--extension`/`-e` 与 `--no-extensions`/`-ne` 参数，因此通过命令行手动加载的扩展在子智能体中同样生效。

## 开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 类型检查
npm run typecheck
```

如需在本地开发时直接加载扩展（无需打包），请在仓库根目录运行：

```bash
pi -e ./extension/index.ts
```

项目使用 TypeScript 编写，测试采用 Node.js 内置测试运行器。

## 项目结构

```text
pi-lite-subagent/
├── extension/
│   ├── index.ts          # 扩展入口（仅组装依赖）
│   ├── agents.ts         # 智能体发现与 frontmatter 解析
│   ├── env-vars.ts       # PI_SUBAGENT_* 变量、深度门控、子进程环境
│   ├── run-agent.ts      # pi 调用、子进程、JSON 事件流
│   ├── truncation.ts     # 输出截断与临时文件落盘
│   ├── active-agent.ts   # 子会话标识、渲染器、只读拦截
│   ├── subagent-tool.ts  # subagent 工具：参数、调度、渲染
│   ├── subagent-rendering.ts / result-details.ts / result-parsing.ts  # 公共渲染、结果 Schema、详情解析
│   ├── subagent-list.ts / subagent-browser.ts / subagent-history.ts   # /list-subagents、浮窗浏览、/view-subagents
│   ├── subagent-sessions.ts / session-selector.ts                     # 子会话扫描与 inline 选单
│   ├── session-navigation.ts / shared-state.ts / session-paths.ts     # 跳转命令、进程内共享状态、路径规则
│   ├── utils.ts / utils-pi.ts                                         # 公共工具
│   └── types.ts          # 共享接口与结果类型
└── tests/                # 单元测试与集成测试
```

## 致谢

智能体发现、进程调用与渲染逻辑改编自 Pi Coding Agent 自带的
[subagent 示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)，并做了较大幅度的重组与扩展。详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 许可

[MIT](./LICENSE)
