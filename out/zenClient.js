"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZEN_BASE_URL = void 0;
exports.streamZen = streamZen;
const openai_compatible_1 = require("@ai-sdk/openai-compatible");
const ai_1 = require("ai");
exports.ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
async function streamZen(options, callbacks) {
    const zen = (0, openai_compatible_1.createOpenAICompatible)({
        name: 'opencode-zen',
        apiKey: options.apiKey,
        baseURL: exports.ZEN_BASE_URL,
    });
    const result = (0, ai_1.streamText)({
        model: zen(options.modelId),
        messages: options.messages,
        tools: options.tools,
        toolChoice: options.toolMode,
        abortSignal: options.abortSignal,
        providerOptions: options.modelOptions,
        // Avoid tool-call streaming deltas; we want complete tool calls.
        toolCallStreaming: false,
    });
    let emitted = false;
    let sawAnyChunk = false;
    for await (const part of result.fullStream) {
        sawAnyChunk = true;
        if (part.type === 'text-delta') {
            emitted = emitted || part.textDelta.length > 0;
            callbacks.onTextDelta(part.textDelta);
            continue;
        }
        // Some providers emit reasoning tokens separately. VS Code doesn't have a reasoning response part,
        // so we surface it as normal text.
        if (part.type === 'reasoning') {
            if (part.textDelta && part.textDelta.length > 0) {
                emitted = true;
                callbacks.onTextDelta(part.textDelta);
            }
            continue;
        }
        if (part.type === 'tool-call') {
            emitted = true;
            callbacks.onToolCall({
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: (part.args ?? {}),
            });
            continue;
        }
        if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
        // Ignore finish/metadata parts.
    }
    // VS Code shows "Sorry, no response was returned" if we emit nothing.
    if (!emitted) {
        callbacks.onTextDelta(sawAnyChunk ? '\n' : 'No response returned by model.');
    }
}
//# sourceMappingURL=zenClient.js.map