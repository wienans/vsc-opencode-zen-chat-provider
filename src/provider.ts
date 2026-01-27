import { randomUUID } from 'crypto';
import { jsonSchema } from 'ai';
import * as vscode from 'vscode';
import { getApiKey } from './secrets';
import { ModelRegistry } from './modelRegistry';
import { OPENAI_COMPAT_PROVIDER_NAME, streamZen } from './zenClient';
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
		const promptCaching = getPromptCachingConfig();
		const promptCacheKey =
			promptCaching.enabled && promptCaching.cacheKeyScope !== 'none'
				? await getOrCreatePromptCacheKey(this.context, promptCaching.cacheKeyScope)
				: undefined;
		const cacheRetention = promptCaching.enabled ? promptCaching.retention : undefined;
		const anthropicCacheControl =
			promptCaching.enabled && providerInfo?.npm === '@ai-sdk/anthropic'
				? buildAnthropicCacheControl(promptCaching.anthropicTtl)
				: undefined;
		let cachedMessages = coreMessages;
		if (promptCaching.enabled && anthropicCacheControl) {
			cachedMessages = applyAnthropicCacheControl(coreMessages, anthropicCacheControl);
		} else if (promptCaching.enabled && providerInfo?.npm === '@ai-sdk/openai-compatible') {
			if (isGlm47ModelId(model.id)) {
				cachedMessages = removeOpenAICompatibleCacheControl(coreMessages);
			} else {
				cachedMessages = applyOpenAICompatibleCacheControl(coreMessages);
			}
		} else if (providerInfo?.npm === '@ai-sdk/openai-compatible') {
			cachedMessages = removeOpenAICompatibleCacheControl(coreMessages);
		}

		const { debugFlag, modelOptions } = splitDebugOptions(options.modelOptions);
		const providerOptions = buildProviderOptions(modelOptions, providerInfo?.npm, promptCacheKey, cacheRetention);

		if (debugFlag) {
			logDebugRequest(model, toolMode, options, coreMessages, tools, providerInfo, providerOptions);
		}

		try {
			await streamZen(
				{
					apiKey,
					modelId: model.id,
					messages: cachedMessages,
					tools,
					toolMode,
					abortSignal: abortController.signal,
					providerOptions,
					providerNpm: providerInfo?.npm,
					baseURL: providerInfo?.api,
					toolNameMap: toolNameMap.toVsCode,
					debugLogging: debugFlag,
					includeUsage: promptCaching.enabled,
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
			if (part.mimeType === 'cache_control') {
				continue;
			}
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
		const schema = normalizeToolSchema(tool.inputSchema);
		const name = mapToolName(tool.name, toolNameMap);
		mapped[name] = {
			description: tool.description,
			inputSchema: jsonSchema(schema as any),
			// No `execute`: VS Code invokes tools and sends results back on next turn.
		};
	}
	return mapped;
}

function normalizeToolSchema(schema: unknown): unknown {
	const fallback = { type: 'object', properties: {}, additionalProperties: true };
	if (!schema || typeof schema !== 'object') {
		return fallback;
	}

	const record = schema as Record<string, unknown>;
	if (record.type === 'object') {
		const hasProperties = typeof record.properties === 'object' && record.properties !== null;
		return {
			...record,
			properties: hasProperties ? record.properties : {},
			additionalProperties:
				record.additionalProperties === undefined ? true : record.additionalProperties,
		};
	}

	return record;
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

type PromptCachingConfig = {
	enabled: boolean;
	retention: 'in_memory' | '24h';
	cacheKeyScope: 'workspace' | 'global' | 'none';
	anthropicTtl: '5m' | '1h' | 'none';
};

function getPromptCachingConfig(): PromptCachingConfig {
	const config = vscode.workspace.getConfiguration('opencodeZen');
	return {
		enabled: config.get<boolean>('promptCaching.enabled', true),
		retention: config.get<'in_memory' | '24h'>('promptCaching.retention', 'in_memory'),
		cacheKeyScope: config.get<'workspace' | 'global' | 'none'>('promptCaching.cacheKeyScope', 'workspace'),
		anthropicTtl: config.get<'5m' | '1h' | 'none'>('promptCaching.anthropicTtl', '5m'),
	};
}

async function getOrCreatePromptCacheKey(
	context: vscode.ExtensionContext,
	scope: 'workspace' | 'global'
): Promise<string> {
	const storage = scope === 'global' ? context.globalState : context.workspaceState;
	const keyName = 'opencodeZen.promptCacheKey';
	let key = storage.get<string>(keyName);
	if (!key) {
		key = randomUUID();
		await storage.update(keyName, key);
	}
	return key;
}

function buildAnthropicCacheControl(ttl: '5m' | '1h' | 'none'): { type: 'ephemeral'; ttl?: '5m' | '1h' } {
	if (ttl === 'none') {
		return { type: 'ephemeral' };
	}
	return { type: 'ephemeral', ttl };
}

function applyAnthropicCacheControl(messages: any[], cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' }): any[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}

	return applyCacheControlToMessages(messages, (message) => {
		const existing = (message.providerOptions as Record<string, any> | undefined)?.anthropic;
		if (existing?.cacheControl || existing?.cache_control) {
			return message;
		}
		return {
			...message,
			providerOptions: mergeProviderOptions(message.providerOptions, { anthropic: { cacheControl } }),
		};
	});
}

function applyOpenAICompatibleCacheControl(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}

	return applyCacheControlToMessages(messages, (message) => {
		const existing = (message.providerOptions as Record<string, any> | undefined)?.openaiCompatible;
		if (existing?.cache_control) {
			return message;
		}
		return {
			...message,
			providerOptions: mergeProviderOptions(message.providerOptions, {
				openaiCompatible: { cache_control: { type: 'ephemeral' } },
			}),
		};
	});
}

function removeOpenAICompatibleCacheControl(messages: any[]): any[] {
	if (!Array.isArray(messages) || messages.length === 0) {
		return messages;
	}

	let changed = false;
	const stripped = messages.map((message) => {
		if (!message || typeof message !== 'object') {
			return message;
		}
		const providerOptions = (message.providerOptions as Record<string, any> | undefined)?.openaiCompatible;
		if (!providerOptions || providerOptions.cache_control === undefined) {
			return message;
		}
		changed = true;
		const merged = mergeProviderOptions(message.providerOptions, {
			openaiCompatible: { cache_control: undefined },
		});
		return {
			...message,
			providerOptions: merged,
		};
	});

	return changed ? stripped : messages;
}

function isGlm47ModelId(modelId: string): boolean {
	const normalized = modelId.trim().toLowerCase();
	return normalized === 'glm-4.7' || normalized.endsWith('/glm-4.7');
}

function applyCacheControlToMessages(messages: any[], updater: (message: any) => any): any[] {
	const systemIndices: number[] = [];
	const nonSystemIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const role = messages[i]?.role;
		if (role === 'system') {
			systemIndices.push(i);
		} else {
			nonSystemIndices.push(i);
		}
	}

	const selected = new Set<number>();
	for (const index of systemIndices.slice(0, 2)) {
		selected.add(index);
	}
	for (const index of nonSystemIndices.slice(-2)) {
		selected.add(index);
	}

	if (selected.size === 0) {
		return messages;
	}

	return messages.map((message, index) => {
		if (!selected.has(index) || !message || typeof message !== 'object') {
			return message;
		}
		return updater(message);
	});
}

function buildProviderOptions(
	modelOptions: Record<string, unknown> | undefined,
	providerNpm: string | undefined,
	cacheKey: string | undefined,
	retention: 'in_memory' | '24h' | undefined
): Record<string, unknown> | undefined {
	if (!cacheKey) {
		return modelOptions;
	}

	const merged = modelOptions ? { ...modelOptions } : {};

	if (providerNpm === '@ai-sdk/openai') {
		const openai = { ...(merged.openai as Record<string, unknown> | undefined) };
		openai.promptCacheKey = cacheKey;
		if (retention && retention !== 'in_memory') {
			openai.promptCacheRetention = retention;
		}
		merged.openai = openai;
		return merged;
	}

	if (providerNpm === '@ai-sdk/openai-compatible') {
		const compatible = { ...(merged[OPENAI_COMPAT_PROVIDER_NAME] as Record<string, unknown> | undefined) };
		compatible.prompt_cache_key = cacheKey;
		if (retention && retention !== 'in_memory') {
			compatible.prompt_cache_retention = retention;
		}
		merged[OPENAI_COMPAT_PROVIDER_NAME] = compatible;
		return merged;
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeProviderOptions(
	base: Record<string, unknown> | undefined,
	addition: Record<string, unknown>
): Record<string, unknown> {
	if (!base || typeof base !== 'object') {
		return { ...addition };
	}

	const merged = { ...base } as Record<string, unknown>;
	for (const [key, value] of Object.entries(addition)) {
		const existing = merged[key];
		if (existing && typeof existing === 'object' && value && typeof value === 'object') {
			merged[key] = { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) };
		} else {
			merged[key] = value;
		}
	}
	return merged;
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
	providerInfo: { npm: string; api: string } | undefined,
	providerOptions: Record<string, unknown> | undefined,
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
		providerOptions: providerOptions ?? options.modelOptions ?? undefined,
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
