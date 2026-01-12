"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenCodeZenChatProvider = exports.VENDOR_ID = void 0;
const vscode = __importStar(require("vscode"));
const ai_1 = require("ai");
const secrets_1 = require("./secrets");
const modelRegistry_1 = require("./modelRegistry");
const zenClient_1 = require("./zenClient");
exports.VENDOR_ID = 'opencode';
class OpenCodeZenChatProvider {
    context;
    registry;
    onDidChangeEmitter = new vscode.EventEmitter();
    onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;
    constructor(context) {
        this.context = context;
        this.registry = new modelRegistry_1.ModelRegistry(context);
        this.registry.onDidChange(() => this.onDidChangeEmitter.fire());
    }
    async refreshModels(force = false) {
        if (force) {
            this.registry.invalidate();
            return;
        }
        // Best-effort refresh, but don't crash activation.
        try {
            await this.registry.getModels({ force: true });
            this.onDidChangeEmitter.fire();
        }
        catch {
            // ignore
        }
    }
    provideLanguageModelChatInformation(_options, _token) {
        return this.registry.getModels().catch((err) => {
            // If model metadata fetch fails, surface no models rather than throwing.
            console.error(err);
            return [];
        });
    }
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
        const apiKey = await (0, secrets_1.getApiKey)(this.context.secrets);
        if (!apiKey) {
            throw new Error("OpenCode Zen API key not set. Run 'OpenCode Zen: Set API Key'.");
        }
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());
        const toolMode = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
        const tools = options.tools ? toolsToAiSdkTools(options.tools) : undefined;
        const coreMessages = messagesToAiSdkMessages(messages);
        await (0, zenClient_1.streamZen)({
            apiKey,
            modelId: model.id,
            messages: coreMessages,
            tools,
            toolMode,
            abortSignal: abortController.signal,
            modelOptions: options.modelOptions ?? undefined,
        }, {
            onTextDelta: (delta) => {
                if (delta) {
                    progress.report(new vscode.LanguageModelTextPart(delta));
                }
            },
            onToolCall: ({ toolCallId, toolName, input }) => {
                progress.report(new vscode.LanguageModelToolCallPart(toolCallId, toolName, input));
            },
        });
    }
    async provideTokenCount(_model, text, _token) {
        // VS Code uses this for planning/truncation. We provide a rough estimate.
        const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
        return Math.max(1, Math.ceil(serialized.length / 4));
    }
}
exports.OpenCodeZenChatProvider = OpenCodeZenChatProvider;
function messagesToAiSdkMessages(messages) {
    // We use `any` to avoid hard-coupling to ai-sdk's evolving CoreMessage shape.
    // But we must still satisfy AI SDK runtime validation.
    const toolNameByCallId = new Map();
    for (const message of messages) {
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelToolCallPart) {
                toolNameByCallId.set(part.callId, part.name);
            }
        }
    }
    const out = [];
    for (const message of messages) {
        const mapped = mapVsCodeMessageToAiSdkMessages(message, toolNameByCallId);
        out.push(...mapped);
    }
    return out;
}
function mapVsCodeMessageToAiSdkMessages(message, toolNameByCallId) {
    const isUser = message.role === vscode.LanguageModelChatMessageRole.User;
    const textImageFileParts = [];
    const toolResultParts = [];
    const assistantParts = [];
    for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            const textPart = { type: 'text', text: part.value };
            if (isUser) {
                textImageFileParts.push(textPart);
            }
            else {
                assistantParts.push(textPart);
            }
            continue;
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
            // Assistant-only in VS Code input, but we handle defensively.
            assistantParts.push({
                type: 'tool-call',
                toolCallId: part.callId,
                toolName: part.name,
                args: part.input,
            });
            continue;
        }
        if (part instanceof vscode.LanguageModelToolResultPart) {
            const toolName = toolNameByCallId.get(part.callId) ?? 'unknown';
            toolResultParts.push({
                type: 'tool-result',
                toolCallId: part.callId,
                toolName,
                result: languageModelToolResultContentToResult(part.content),
            });
            continue;
        }
        if (part instanceof vscode.LanguageModelDataPart) {
            const converted = dataPartToAiSdkPart(part);
            if (!converted) {
                continue;
            }
            if (isUser) {
                textImageFileParts.push(converted);
            }
            else {
                assistantParts.push(converted);
            }
            continue;
        }
        // Unknown VS Code part; drop to keep AI SDK validation happy.
    }
    const out = [];
    if (isUser) {
        if (textImageFileParts.length > 0) {
            out.push({ role: 'user', content: simplifyTextOnlyContent(textImageFileParts) });
        }
        if (toolResultParts.length > 0) {
            out.push({ role: 'tool', content: toolResultParts });
        }
    }
    else {
        out.push({ role: 'assistant', content: simplifyTextOnlyContent(assistantParts) });
    }
    return out;
}
function simplifyTextOnlyContent(parts) {
    if (parts.length === 0) {
        return '';
    }
    if (parts.every((p) => p?.type === 'text' && typeof p.text === 'string')) {
        // Use string to satisfy the strictest schema path.
        return parts.map((p) => p.text).join('');
    }
    return parts;
}
function dataPartToAiSdkPart(part) {
    // VS Code may include internal metadata such as cache_control in Agent/Plan mode.
    if (part.mimeType === 'cache_control') {
        return undefined;
    }
    if (part.mimeType.startsWith('text/')) {
        return { type: 'text', text: new TextDecoder('utf-8').decode(part.data) };
    }
    if (part.mimeType.startsWith('image/')) {
        // AI SDK accepts Buffer/Uint8Array.
        return { type: 'image', image: Buffer.from(part.data), mimeType: part.mimeType };
    }
    // Fallback: represent as a file.
    return { type: 'file', data: Buffer.from(part.data), mimeType: part.mimeType };
}
function languageModelToolResultContentToResult(content) {
    // Preserve structure as best as possible without leaking VS Code classes to the provider.
    return content
        .map((part) => {
        if (part instanceof vscode.LanguageModelTextPart) {
            return part.value;
        }
        if (part instanceof vscode.LanguageModelPromptTsxPart) {
            return part.value;
        }
        if (part instanceof vscode.LanguageModelDataPart) {
            if (part.mimeType.startsWith('text/')) {
                return new TextDecoder('utf-8').decode(part.data);
            }
            return { mimeType: part.mimeType, data: Buffer.from(part.data).toString('base64') };
        }
        return part;
    })
        .filter((x) => x !== undefined);
}
function toolsToAiSdkTools(tools) {
    const mapped = {};
    for (const tool of tools) {
        // AI SDK expects either a Zod schema or a JSON Schema wrapped with jsonSchema().
        // VS Code provides plain JSON Schema objects, so we wrap them.
        const schema = tool.inputSchema ?? { type: 'object', additionalProperties: true };
        mapped[tool.name] = {
            description: tool.description,
            parameters: (0, ai_1.jsonSchema)(schema),
            // No `execute`: VS Code invokes tools and sends results back on next turn.
        };
    }
    return mapped;
}
//# sourceMappingURL=provider.js.map