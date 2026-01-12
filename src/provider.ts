import * as vscode from 'vscode';
import { jsonSchema } from 'ai';
import { getApiKey } from './secrets';
import { ModelRegistry } from './modelRegistry';
import { streamZen } from './zenClient';

export const VENDOR_ID = 'opencode';

export class OpenCodeZenChatProvider implements vscode.LanguageModelChatProvider {
	private readonly registry: ModelRegistry;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.registry = new ModelRegistry(context);
		this.registry.onDidChange(() => this.onDidChangeEmitter.fire());
	}

	async refreshModels(force = false): Promise<void> {
		if (force) {
			this.registry.invalidate();
			return;
		}

		// Best-effort refresh, but don't crash activation.
		try {
			await this.registry.getModels({ force: true });
			this.onDidChangeEmitter.fire();
		} catch {
			// ignore
		}
	}

	provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		return this.registry.getModels().catch((err) => {
			// If model metadata fetch fails, surface no models rather than throwing.
			console.error(err);
			return [];
		});
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const apiKey = await getApiKey(this.context.secrets);
		if (!apiKey) {
			throw new Error("OpenCode Zen API key not set. Run 'OpenCode Zen: Set API Key'.");
		}

		const abortController = new AbortController();
		token.onCancellationRequested(() => abortController.abort());

		const toolMode = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
		const tools = options.tools ? toolsToAiSdkTools(options.tools) : undefined;
		const coreMessages = messagesToAiSdkMessages(messages);

		await streamZen(
			{
				apiKey,
				modelId: model.id,
				messages: coreMessages,
				tools,
				toolMode,
				abortSignal: abortController.signal,
				modelOptions: options.modelOptions ?? undefined,
			},
			{
				onTextDelta: (delta) => {
					if (delta) {
						progress.report(new vscode.LanguageModelTextPart(delta));
					}
				},
				onToolCall: ({ toolCallId, toolName, input }) => {
					progress.report(new vscode.LanguageModelToolCallPart(toolCallId, toolName, input));
				},
			}
		);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		// VS Code uses this for planning/truncation. We provide a rough estimate.
		const serialized = typeof text === 'string' ? text : JSON.stringify(text.content);
		return Math.max(1, Math.ceil(serialized.length / 4));
	}
}

function messagesToAiSdkMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): any[] {
	// We use `any` to avoid hard-coupling to ai-sdk's evolving CoreMessage shape.
	// But we must still satisfy AI SDK runtime validation.
	const toolNameByCallId = new Map<string, string>();
	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNameByCallId.set(part.callId, part.name);
			}
		}
	}

	const out: any[] = [];

	for (const message of messages) {
		const mapped = mapVsCodeMessageToAiSdkMessages(message, toolNameByCallId);
		out.push(...mapped);
	}

	return out;
}

function mapVsCodeMessageToAiSdkMessages(
	message: vscode.LanguageModelChatRequestMessage,
	toolNameByCallId: ReadonlyMap<string, string>
): any[] {
	const isUser = message.role === vscode.LanguageModelChatMessageRole.User;

	const textImageFileParts: any[] = [];
	const toolResultParts: any[] = [];
	const assistantParts: any[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			const textPart = { type: 'text', text: part.value };
			if (isUser) {
				textImageFileParts.push(textPart);
			} else {
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
			} else {
				assistantParts.push(converted);
			}
			continue;
		}

		// Unknown VS Code part; drop to keep AI SDK validation happy.
	}

	const out: any[] = [];

	if (isUser) {
		if (textImageFileParts.length > 0) {
			out.push({ role: 'user', content: simplifyTextOnlyContent(textImageFileParts) });
		}
		if (toolResultParts.length > 0) {
			out.push({ role: 'tool', content: toolResultParts });
		}
	} else {
		out.push({ role: 'assistant', content: simplifyTextOnlyContent(assistantParts) });
	}

	return out;
}

function simplifyTextOnlyContent(parts: any[]): any {
	if (parts.length === 0) {
		return '';
	}
	if (parts.every((p) => p?.type === 'text' && typeof p.text === 'string')) {
		// Use string to satisfy the strictest schema path.
		return parts.map((p) => p.text).join('');
	}
	return parts;
}

function dataPartToAiSdkPart(part: vscode.LanguageModelDataPart): any | undefined {
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

function languageModelToolResultContentToResult(
	content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>
): unknown {
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

function toolsToAiSdkTools(tools: readonly vscode.LanguageModelChatTool[]): Record<string, any> {
	const mapped: Record<string, any> = {};
	for (const tool of tools) {
		// AI SDK expects either a Zod schema or a JSON Schema wrapped with jsonSchema().
		// VS Code provides plain JSON Schema objects, so we wrap them.
		const schema = tool.inputSchema ?? { type: 'object', additionalProperties: true };
		mapped[tool.name] = {
			description: tool.description,
			parameters: jsonSchema(schema as any),
			// No `execute`: VS Code invokes tools and sends results back on next turn.
		};
	}
	return mapped;
}
