import * as vscode from 'vscode';
import { jsonSchema } from 'ai';
import { getApiKey } from './secrets';
import { ModelRegistry } from './modelRegistry';
import { streamZen } from './zenClient';
import { getOutputChannel } from './output';

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
		const providerInfo = await this.registry.getModelProviderInfo(model.id);
		const toolNameMap = buildToolNameMap(options.tools, providerInfo?.npm);
		const tools = options.tools ? toolsToAiSdkTools(options.tools, toolNameMap.toProvider) : undefined;
		const coreMessages = messagesToAiSdkMessages(messages, toolNameMap.toProvider);

		const { debugFlag, modelOptions } = splitDebugOptions(options.modelOptions);

		if (debugFlag) {
			logDebugRequest(model, toolMode, options, coreMessages, tools, providerInfo);
		}

		try {
			await streamZen(
				{
					apiKey,
					modelId: model.id,
					messages: coreMessages,
					tools,
					toolMode,
					abortSignal: abortController.signal,
					modelOptions,
					providerNpm: providerInfo?.npm,
					baseURL: providerInfo?.api,
					toolNameMap: toolNameMap.toVsCode,
					debugLogging: debugFlag,
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
		} catch (err) {
			if (debugFlag) {
				logDebugError(model, toolMode, options, coreMessages, tools, providerInfo, err);
			}
			throw err;
		}
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

function messagesToAiSdkMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	toolNameMap: ReadonlyMap<string, string>
): any[] {
	// We use `any` to avoid hard-coupling to ai-sdk's evolving CoreMessage shape.
	// But we must still satisfy AI SDK runtime validation.
	const toolNameByCallId = new Map<string, string>();
	for (const message of messages) {
		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolNameByCallId.set(part.callId, mapToolName(part.name, toolNameMap));
			}
		}
	}

	const out: any[] = [];

	for (const message of messages) {
		const mapped = mapVsCodeMessageToAiSdkMessages(message, toolNameByCallId, toolNameMap);
		out.push(...mapped);
	}

	return out;
}

function mapVsCodeMessageToAiSdkMessages(
	message: vscode.LanguageModelChatRequestMessage,
	toolNameByCallId: ReadonlyMap<string, string>,
	toolNameMap: ReadonlyMap<string, string>
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
				toolName: mapToolName(part.name, toolNameMap),
				input: part.input,
			});
			continue;
		}

		if (part instanceof vscode.LanguageModelToolResultPart) {
			const toolName = toolNameByCallId.get(part.callId) ?? mapToolName('unknown', toolNameMap);
			toolResultParts.push({
				type: 'tool-result',
				toolCallId: part.callId,
				toolName,
				output: languageModelToolResultContentToOutput(part.content),
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

function languageModelToolResultContentToOutput(
	content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart | vscode.LanguageModelDataPart | unknown>
): { type: 'text'; value: string } | { type: 'json'; value: unknown } | { type: 'content'; value: Array<any> } {
	const parts: Array<any> = [];
	const textChunks: string[] = [];

	for (const part of content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textChunks.push(part.value);
			parts.push({ type: 'text', text: part.value });
			continue;
		}
		if (part instanceof vscode.LanguageModelPromptTsxPart) {
			const text = String(part.value);
			textChunks.push(text);
			parts.push({ type: 'text', text });
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType.startsWith('text/')) {
				const text = new TextDecoder('utf-8').decode(part.data);
				textChunks.push(text);
				parts.push({ type: 'text', text });
				continue;
			}
			const base64 = Buffer.from(part.data).toString('base64');
			if (part.mimeType.startsWith('image/')) {
				parts.push({ type: 'image-data', data: base64, mediaType: part.mimeType });
				continue;
			}
			parts.push({ type: 'file-data', data: base64, mediaType: part.mimeType });
			continue;
		}

		if (part !== undefined) {
			parts.push({ type: 'custom', value: part });
		}
	}

	if (parts.length === 0) {
		return { type: 'text', value: '' };
	}

	if (parts.every((p) => p.type === 'text')) {
		return { type: 'text', value: textChunks.join('') };
	}

	return { type: 'content', value: parts };
}

function toolsToAiSdkTools(
	tools: readonly vscode.LanguageModelChatTool[],
	toolNameMap: ReadonlyMap<string, string>
): Record<string, any> {
	const mapped: Record<string, any> = {};
	for (const tool of tools) {
		// AI SDK expects either a Zod schema or a JSON Schema wrapped with jsonSchema().
		// VS Code provides plain JSON Schema objects, so we wrap them.
		const schema = tool.inputSchema ?? { type: 'object', additionalProperties: true };
		const name = mapToolName(tool.name, toolNameMap);
		mapped[name] = {
			description: tool.description,
			inputSchema: jsonSchema(schema as any),
			// No `execute`: VS Code invokes tools and sends results back on next turn.
		};
	}
	return mapped;
}

function buildToolNameMap(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	providerNpm: string | undefined
): { toProvider: Map<string, string>; toVsCode: Map<string, string> } {
	const toProvider = new Map<string, string>();
	const toVsCode = new Map<string, string>();

	if (!tools || tools.length === 0) {
		return { toProvider, toVsCode };
	}

	const needsSanitize = providerNpm === '@ai-sdk/anthropic' || providerNpm === '@ai-sdk/openai';
	const used = new Set<string>();

	for (const tool of tools) {
		const baseName = needsSanitize ? sanitizeToolName(tool.name) : tool.name;
		let name = baseName;
		let suffix = 1;
		while (used.has(name)) {
			name = `${baseName}_${suffix++}`.slice(0, 128);
		}
		used.add(name);
		toProvider.set(tool.name, name);
		toVsCode.set(name, tool.name);
	}

	return { toProvider, toVsCode };
}

function sanitizeToolName(name: string): string {
	const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
	const trimmed = cleaned.length > 0 ? cleaned.slice(0, 128) : 'tool';
	return trimmed;
}

function mapToolName(name: string, toolNameMap: ReadonlyMap<string, string>): string {
	return toolNameMap.get(name) ?? name;
}

function splitDebugOptions(
	modelOptions: vscode.ProvideLanguageModelChatResponseOptions['modelOptions'] | undefined
): { debugFlag: boolean; modelOptions?: Record<string, unknown> } {
	if (!modelOptions || typeof modelOptions !== 'object') {
		return { debugFlag: false, modelOptions: modelOptions as Record<string, unknown> | undefined };
	}

	const copy = { ...(modelOptions as Record<string, unknown>) };
	const debugFlag = Boolean(copy.__opencodeDebugSelfTest);
	delete copy.__opencodeDebugSelfTest;

	return { debugFlag, modelOptions: Object.keys(copy).length > 0 ? copy : undefined };
}

function logDebugRequest(
	model: vscode.LanguageModelChatInformation,
	toolMode: 'required' | 'auto',
	options: vscode.ProvideLanguageModelChatResponseOptions,
	coreMessages: any[],
	tools: Record<string, any> | undefined,
	providerInfo: { npm: string; api: string } | undefined
): void {
	const output = getOutputChannel();
	output.info('Debug: provider request payload');
	output.info(`Model: ${model.name} (${model.id})`);
	output.info(`Tool mode: ${toolMode}`);
	output.info(`Tools enabled: ${tools ? Object.keys(tools).length : 0}`);
	output.append(`\n${safeJson({
		modelId: model.id,
		messages: coreMessages,
		tools,
		toolMode,
		modelOptions: options.modelOptions ?? undefined,
		provider: providerInfo,
	})}\n`);
}

function logDebugError(
	model: vscode.LanguageModelChatInformation,
	toolMode: 'required' | 'auto',
	options: vscode.ProvideLanguageModelChatResponseOptions,
	coreMessages: any[],
	tools: Record<string, any> | undefined,
	providerInfo: { npm: string; api: string } | undefined,
	err: unknown
): void {
	const output = getOutputChannel();
	output.error('Debug: provider error');
	output.info(`Model: ${model.name} (${model.id})`);
	output.info(`Tool mode: ${toolMode}`);
	output.append(`\n${safeJson({
		modelId: model.id,
		messages: coreMessages,
		tools,
		toolMode,
		modelOptions: options.modelOptions ?? undefined,
		provider: providerInfo,
		error: serializeError(err),
	})}\n`);
}

function serializeError(err: unknown): unknown {
	const seen = new Set<unknown>();

	const toPlain = (value: unknown, depth: number): unknown => {
		if (value === null || value === undefined) {
			return value;
		}
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			return value;
		}
		if (value instanceof Uint8Array) {
			return Buffer.from(value).toString('utf-8');
		}
		if (typeof value !== 'object') {
			return String(value);
		}
		if (seen.has(value)) {
			return '[Circular]';
		}
		seen.add(value);
		if (depth <= 0) {
			return '[MaxDepth]';
		}

		const record = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.getOwnPropertyNames(record)) {
			out[key] = toPlain(record[key], depth - 1);
		}
		if ('cause' in record) {
			out.cause = toPlain(record.cause, depth - 1);
		}
		return out;
	};

	return toPlain(err, 4);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
