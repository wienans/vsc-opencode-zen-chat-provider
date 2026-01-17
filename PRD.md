# Product Requirements Document (PRD)

## Product Overview
**Product name:** OpenCode Zen – VS Code Chat Model Provider  
**Type:** VS Code extension (Language Model Chat Provider)  
**Vendor ID:** opencode  
**Purpose:** Expose OpenCode Zen models to VS Code’s Language Model Chat Provider API with streaming responses and tool-calling support.

## Goals
- Provide OpenCode Zen chat models inside VS Code’s model picker.
- Support streaming assistant responses and tool calling.
- Offer secure API key storage and basic operational commands.
- Keep model metadata fresh with configurable caching.
- Provide diagnostics for debugging and a self-test workflow.

## Non-Goals
- Custom UI beyond VS Code’s native chat experience.
- Tool execution logic (VS Code handles tool execution).
- Local model hosting or fine-tuning.

## Target Users
- VS Code users who want to use OpenCode Zen models in the built-in Chat view.

## User Stories
1. As a user, I can select “OpenCode Zen” models in VS Code’s model picker and chat with them.
2. As a user, I can set or clear my OpenCode API key securely via commands.
3. As a user, I can refresh the model list without restarting VS Code.
4. As a user, I can run a self-test to validate streaming and tool calling.
5. As a developer, I can inspect debug logs for requests and errors.

## Functional Requirements

### 1) Language Model Chat Provider
- **Provider registration:** Registers the vendor `opencode` as a language model chat provider.
- **Model listing:** Retrieves models from https://models.dev/api.json filtered to provider `opencode`.
- **Model metadata:** Exposes model name, family, version, capabilities (tool calling, image input), and token limits to VS Code.
- **Model selection:** Integrates with VS Code’s model picker and provides model info to the host.

### 2) Streaming Chat Responses
- **Streaming output:** Streams assistant text deltas to VS Code via `LanguageModelTextPart`.
- **Reasoning tokens:** If a provider emits reasoning deltas, they are surfaced as normal text.
- **Empty response handling:** If no output is emitted, a fallback message is returned.

### 3) Tool Calling Support
- **Tool schema support:** Accepts JSON Schema from VS Code tools, wraps it for AI SDK validation.
- **Tool call streaming:** Emits `LanguageModelToolCallPart` with tool call ID, name, and input.
- **Tool results:** Supports tool result parts in subsequent requests.
- **Tool name mapping:** Sanitizes tool names for certain providers and preserves a reversible name map.
- **Tool call modes:** Supports `required` and `auto` tool modes.

### 4) Message Conversion & Attachments
- **Message mapping:** Converts VS Code chat messages into AI SDK-compatible messages.
- **Attachments handling:** Supports text, images, and file-like data parts.
- **Cache control metadata:** Ignores internal cache-control data parts.

### 5) Secure API Key Management
- **Secret storage:** Saves and retrieves the OpenCode API key using `SecretStorage`.
- **Commands:**
  - Set API key
  - Clear API key
- **Error message:** If missing or invalid, provides actionable error messages.

### 6) Model Registry & Caching
- **Cache with TTL:** Model list caching with configurable TTL (default 15 minutes).
- **Disable caching:** TTL = 0 disables caching.
- **Invalidate cache:** Manual invalidation via refresh command.
- **Model provider overrides:** Supports per-model provider overrides from models.dev.

### 7) Diagnostics & Debugging
- **Output channel:** Logs to “OpenCode Zen” output channel with log levels.
- **Self-test:** Runs a tool-calling roundtrip for a selected model.
- **Debug flag:** Supports an internal `__opencodeDebugSelfTest` model option to enable request/response logging.
- **API error wrapping:** Provides user-friendly error messaging for Unauthorized and Not Found errors, with additional metadata.

### 8) VS Code Commands
- **OpenCode Zen: Set API Key** (`opencodeZen.setApiKey`)
- **OpenCode Zen: Clear API Key** (`opencodeZen.clearApiKey`)
- **OpenCode Zen: Refresh Model List** (`opencodeZen.refreshModels`)
- **OpenCode Zen: Self Test** (`opencodeZen.selfTest`)

### 9) Configuration
- **Setting:** `opencodeZen.modelCacheTtlMinutes`
  - Type: number
  - Default: 15
  - Minimum: 0
  - Description: Cache TTL for models.dev metadata

## System Behavior

### Activation
- Extension activates on startup and when commands are invoked.

### Model Fetching
- Fetches model metadata from models.dev with best-effort error handling.
- If fetch fails, returns an empty model list (no crashes).

### Request Flow
1. Validate API key.
2. Convert VS Code messages to AI SDK format.
3. Map tool names and schemas as needed.
4. Stream responses and tool calls to VS Code.
5. Log debug data if enabled.

## External Dependencies
- **OpenCode Zen API:** Default base URL https://opencode.ai/zen/v1
- **Models metadata:** https://models.dev/api.json
- **AI SDK:** `ai`, `@ai-sdk/openai-compatible`, `@ai-sdk/openai`, `@ai-sdk/anthropic`

## Security & Privacy
- API key stored only in VS Code `SecretStorage`.
- HTTP logs redact Authorization and API key headers.
- No user data is stored outside of VS Code and external API calls.

## Error Handling
- Missing API key: User is instructed to run “OpenCode Zen: Set API Key”.
- 401 errors: Wrapped with “Unauthorized” guidance.
- 404 errors: Wrapped with “Model not found” guidance.
- Self-test errors logged with model, tool, request/response details.

## Performance & Reliability
- Model list caching reduces repeated network calls.
- Streaming responses reduce latency perception.
- Abort support respects VS Code cancellation tokens.

## Telemetry
- No telemetry or analytics is implemented.

## Acceptance Criteria
- Models from OpenCode appear in the VS Code model picker.
- Streaming text is visible in chat.
- Tool calls are emitted with correct names and inputs.
- API key commands store and clear secrets successfully.
- Refresh command updates model list.
- Self-test completes or logs actionable failure information.

## Out of Scope / Future Considerations
- Custom UI, account management, or billing display.
- Persistent conversation history in the extension.
- Advanced model routing or policy enforcement.
