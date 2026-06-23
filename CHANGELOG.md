# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-06-23

### Added

- Auto-truncate older messages to fit within model context window, preserving tool-call/tool-result pairs.
- Separate thinking/reasoning tokens from regular response using `LanguageModelThinkingPart` (proposed API).
- Emit token usage as `LanguageModelDataPart` for context window display.
- Dev-mode strip/restore script (`scripts/dev-mode.js`) for clean commits.

### Changed

- Improve error messages to include HTTP status, URL, and truncated response body.
- Add VS Code debug configuration (`launch.json`, `tasks.json`) for extension development.

## [0.1.3] - 2026-01-27

### Fixed

- Filter out deprecated models flagged by models.dev status.
- Update GLM 4.7 Handling to reduce error rate for unwanted fields

## [0.1.2] - 2026-01-19

### Added

- Fix Packaging. The VIX didn't package dependencies.

## [0.1.1] - 2026-01-17

### Added

- Added Prompt Caching for all Models

## [0.1.0] - 2026-01-17

### Added

- Initial release of OpenCode Zen VS Code Chat Provider extension
- Integration with OpenCode Zen models via Language Model Chat Provider API
- API key management via VS Code SecretStorage
- Model registry with dynamic model fetching from models.dev
- Streaming support for chat completions
- Tool calling capabilities with JSON Schema support
- Self-test command for validating streaming and tool functionality
- Output channel for debugging and logging
