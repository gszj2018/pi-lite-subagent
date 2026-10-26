# Changelog

All notable changes to this project will be documented in this file.

## [0.2.2] - 2026-10-26

### Fixed
- Remove misleading PgUp/PgDn paging hints from the subagent session selector, where fullscreen mode intercepts these keys.

## [0.2.1] - 2026-10-26

### Added
- Mouse-wheel scrolling for the detail views of `/list-subagents` and `/view-subagents` in fullscreen mode.

## [0.2.0] - 2026-10-24

### Added
- TUI slash command `/list-subagents` to browse discovered user and project agent definitions.
- TUI slash command `/view-subagents` to browse the subagent tasks of the current branch with their status and results.
- TUI slash commands `/switch-to-subagent-session` and `/return-to-parent-session` to navigate into a persisted subagent session and back.

### Changed
- Expanded subagent results show complete bash commands and tool arguments instead of truncated ones.

### Fixed
- Abort listeners are released when a subagent process exits.

## [0.1.0] - 2026-10-20

Initial release.
