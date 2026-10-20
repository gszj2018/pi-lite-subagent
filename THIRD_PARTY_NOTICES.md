# Third-Party Notices

This project incorporates code from the following open-source projects.

## Pi Coding Agent — subagent extension example

- **Source:** https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent
- **Copyright:** Copyright (c) 2025 Mario Zechner
- **License:** MIT License
- **Usage:** Modified portions of the original source code. Agent discovery and frontmatter parsing, `pi` CLI invocation and JSON event-stream handling, usage aggregation, and TUI rendering logic were adapted from the example's `agents.ts` and `index.ts`, then reorganized and substantially modified into `extension/agents.ts`, `extension/run-agent.ts`, `extension/subagent-tool.ts`, and related modules.

The original copyright notices and applicable license texts are retained in this distribution. The upstream MIT license text and copyright notice are reproduced in this project's `LICENSE` file.

Runtime host packages (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) and `typebox` are consumed as declared npm peer dependencies and are not bundled or vendored into this repository; their own copyright notices and license texts apply as distributed by their respective packages.
