# AGENTS.md - OpenCode Zen VS Code Extension

## Overview

This is a VS Code extension that provides OpenCode Zen models via the Language Model Chat Provider API. The codebase is TypeScript with strict mode, using the ai-sdk for API communication.

## Build/Lint/Test Commands

```bash
# Compile TypeScript (outputs to ./out)
npm run compile

# Watch mode for development
npm run watch

# Run ESLint on all TypeScript files
npm run lint

# Download VS Code API types (runs postinstall)
npm run download-api
```

**Debugging in VS Code:**
1. Open folder in VS Code
2. Press `F5` to launch Extension Development Host

## Code Style Guidelines

### Imports

- Use namespace import for VS Code API: `import * as vscode from 'vscode'`
- Use named imports for local modules: `import { functionName } from './module'`
- Use named imports for packages: `import { createOpenAICompatible } from '@ai-sdk/openai-compatible'`

### TypeScript

- **Strict mode enabled** - no implicit `any`, strict null checks, strict function types
- **Allowed `any`**: The eslint rule `@typescript-eslint/no-explicit-any` is disabled. Use `any` sparingly for:
  - Avoiding hard-coupling to evolving SDK types (e.g., ai-sdk CoreMessage shape)
  - AI SDK runtime validation where exact types aren't needed
- Use `ReadonlyMap`, `readonly` parameters, and proper type annotations
- Use interface for object types, type alias for primitives/unions

### Naming Conventions

- **Classes**: PascalCase (`OpenCodeZenChatProvider`, `ModelRegistry`)
- **Functions/variables**: camelCase (`streamZen`, `getApiKey`, `apiKey`)
- **Constants**: SCREAMING_SASE for config values (`ZEN_BASE_URL`, `MODELS_DEV_URL`)
- **Exported constants**: camelCase for runtime values (`VENDOR_ID = 'opencode'`)
- **Types**: PascalCase (e.g., `ModelsDevModel`, `StreamCallbacks`)
- **Tool names**: lowercase with dots (`opencodeZen.selfTest.getTime`)

### Error Handling

- Wrap API errors with contextual messages (see `wrapApiError` in `zenClient.ts:13`)
- Use `try/catch` blocks with `finally` for cleanup (e.g., cancellation tokens)
- Surface user-friendly messages: "Run 'OpenCode Zen: Set API Key'" for missing credentials
- Log errors to console or VS Code output channel, never throw during activation unless critical
- Check for `instanceof Error` before accessing `err.message`

### VS Code Extension Patterns

- Use `vscode.ExtensionContext.subscriptions` for disposables
- Create output channels with `vscode.window.createOutputChannel(..., { log: true })`
- Use `vscode.EventEmitter` for change notifications
- Store secrets in `vscode.SecretStorage`, never in settings
- Store cached data in `vscode.WorkspaceState` with TTL
- Register commands with `vscode.commands.registerCommand`
- Cancellation: use `vscode.CancellationToken` and `AbortController`

### Formatting

- 4-space indentation (TypeScript default)
- Opening brace on same line for functions/control flow
- No comments unless explaining non-obvious behavior
- Blank line between function definitions
- Sort imports: npm packages, VS Code, local modules

### Async/Await

- Always handle promise rejections with try/catch
- Use `async` for functions returning promises
- Prefer `await` over `.then()` chains for readability
- Clean up resources in `finally` blocks or with `using` pattern where applicable

### Tool Calling

- VS Code handles tool execution; provider only emits `LanguageModelToolCallPart`
- Tools defined with JSON Schema, wrapped with `jsonSchema()` for AI SDK
- Provider emits tool calls via callbacks, not streaming deltas
- Use `toolCallStreaming: false` to get complete tool calls

### API Communication

- Use `createOpenAICompatible` from `@ai-sdk/openai-compatible`
- Base URL: `https://opencode.ai/zen/v1`
- Fetch model list from `https://models.dev/api.json`
- Cache model metadata with configurable TTL (default 15 minutes)

### File Organization

- `src/extension.ts` - Activation/deactivation, command registration
- `src/provider.ts` - `OpenCodeZenChatProvider` implementation
- `src/zenClient.ts` - API client and streaming logic
- `src/modelRegistry.ts` - Model fetching and caching
- `src/secrets.ts` - API key storage via SecretStorage
- `src/types.ts` - Shared type definitions

### Testing

- Self-test command (`opencodeZen.selfTest`) validates streaming + tool calling
- Test output written to 'OpenCode Zen' output channel
- Tests run against live models with configured API key

### Key Patterns

1. **Best-effort refresh**: Don't crash activation on model fetch failure
2. **Graceful degradation**: Return empty model list on error rather than throwing
3. **Tool call loop**: 5 iteration limit with explicit error if exceeded
4. **Output channel logging**: Use `output.info()`, `output.error()`, `output.append()`
