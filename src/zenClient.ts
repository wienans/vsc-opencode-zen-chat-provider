import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type ModelMessage } from 'ai';
import { getOutputChannel } from './output';

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

export type ToolMode = 'auto' | 'required';

export type StreamCallbacks = {
  onTextDelta: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCall: (args: { toolCallId: string; toolName: string; input: object }) => void;
};

type ApiErrorDetails = {
	statusCode?: number;
	statusText?: string;
	responseBody?: string;
	requestId?: string;
	url?: string;
	requestBody?: unknown;
	originalMessage?: string;
};

function wrapApiError(err: unknown, extra?: Partial<ApiErrorDetails>): Error {
	const details = { ...extractErrorDetails(err), ...(extra ?? {}) };
	const baseMessage = err instanceof Error ? err.message : String(err);

	if (baseMessage.includes('Unauthorized') || baseMessage.includes('401')) {
		const wrapped = new Error(
			'Unauthorized: Please check your OpenCode API key. Run "OpenCode Zen: Set API Key" to update it.',
			{ cause: err instanceof Error ? err : undefined }
		);
		return Object.assign(wrapped, details);
	}
	if (baseMessage.includes('404') || baseMessage.includes('Not Found')) {
		const wrapped = new Error('Model not found. The requested model may not be available.', {
			cause: err instanceof Error ? err : undefined,
		});
		return Object.assign(wrapped, details);
	}

	const wrapped = new Error(baseMessage, { cause: err instanceof Error ? err : undefined });
	return Object.assign(wrapped, details);
}

function extractErrorDetails(err: unknown): ApiErrorDetails {
	const record = (value: unknown): Record<string, unknown> | undefined => {
		if (value && typeof value === 'object') {
			return value as Record<string, unknown>;
		}
		return undefined;
	};

	const candidates = [record(err), record((err as { cause?: unknown })?.cause)].filter(Boolean) as Record<string, unknown>[];
	const details: ApiErrorDetails = {};

	for (const candidate of candidates) {
		if (details.statusCode === undefined) {
			const status = candidate.statusCode ?? candidate.status;
			if (typeof status === 'number') {
				details.statusCode = status;
			}
		}
		if (details.statusText === undefined && typeof candidate.statusText === 'string') {
			details.statusText = candidate.statusText;
		}
		if (details.url === undefined && typeof candidate.url === 'string') {
			details.url = candidate.url;
		}
		if (details.requestId === undefined && typeof candidate.requestId === 'string') {
			details.requestId = candidate.requestId;
		}
		if (details.responseBody === undefined && candidate.responseBody !== undefined) {
			details.responseBody = normalizeToString(candidate.responseBody);
		}
		if (details.requestBody === undefined && candidate.requestBody !== undefined) {
			details.requestBody = candidate.requestBody;
		}
		if (details.originalMessage === undefined && typeof candidate.message === 'string') {
			details.originalMessage = candidate.message;
		}
	}

	return details;
}

function normalizeToString(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value).toString('utf-8');
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export const OPENAI_COMPAT_PROVIDER_NAME = 'opencode';

export async function streamZen(
	options: {
		apiKey: string;
		modelId: string;
		messages: ModelMessage[];
		tools?: Record<string, any>;
		toolMode: ToolMode;
		abortSignal: AbortSignal;
		headers?: Record<string, string>;
		providerOptions?: Record<string, any>;
		debugLogging?: boolean;
		providerNpm?: string;
		baseURL?: string;
		toolNameMap?: ReadonlyMap<string, string>;
		includeUsage?: boolean;
	},
	callbacks: StreamCallbacks
): Promise<void> {
	if (!options.apiKey || options.apiKey.trim() === '') {
		throw new Error('OpenCode Zen API key is empty. Run "OpenCode Zen: Set API Key" to configure it.');
	}

	const baseURL = options.baseURL ?? ZEN_BASE_URL;
	const providerNpm = options.providerNpm ?? '@ai-sdk/openai-compatible';
	const provider = createProvider(
		providerNpm,
		options.apiKey,
		baseURL,
		options.debugLogging,
		options.includeUsage,
		options.messages
	);
	const endpointPath = getEndpointPath(providerNpm);

	const result = streamText({
		model: provider(options.modelId),
		messages: options.messages,
		headers: options.headers,
		tools: options.tools,
		toolChoice: options.tools ? options.toolMode : undefined,
		abortSignal: options.abortSignal,
		providerOptions: options.providerOptions,
		onFinish: options.includeUsage
			? (result) => {
				const cachedTokens = extractCachedTokens(result?.usage);
				if (cachedTokens) {
					const output = getOutputChannel();
					output.info(
						`Prompt cache: read=${cachedTokens.read ?? 0}, write=${cachedTokens.write ?? 0}, cached=${cachedTokens.cached ?? 0}`
					);
				}
			}
			: undefined,
	});

	const requestBody: Record<string, unknown> = {
		model: options.modelId,
		messages: options.messages,
		tools: options.tools,
		tool_choice: options.tools ? options.toolMode : undefined,
		provider_options: options.providerOptions ?? undefined,
	};

	let emitted = false;
	let sawAnyChunk = false;

	try {
		for await (const part of result.fullStream) {
			sawAnyChunk = true;

			if (part.type === 'text-delta') {
				emitted = emitted || part.text.length > 0;
				callbacks.onTextDelta(part.text);
				continue;
			}

			// Some providers emit reasoning tokens separately. VS Code doesn't have a reasoning response part,
			// so we surface it as normal text.
			if (part.type === 'reasoning-delta') {
				if (part.text && part.text.length > 0) {
					emitted = true;

					// Store this so we can replay it as reasoning_content on the next request.
					callbacks.onReasoningDelta?.(part.text);

					// Optional: do not show hidden thinking as normal chat text.
					// callbacks.onTextDelta(part.text);
				}
				continue;
			}

			if (part.type === 'tool-call') {
				emitted = true;
				callbacks.onToolCall({
					toolCallId: part.toolCallId,
					toolName: options.toolNameMap?.get(part.toolName) ?? part.toolName,
					input: (part.input ?? {}) as object,
				});
				continue;
			}

			if (part.type === 'error') {
				throw wrapApiError(part.error, {
					requestBody,
					url: `${baseURL}${endpointPath}`,
				});
			}

			// Ignore finish/metadata parts.
		}
	} catch (err) {
		throw wrapApiError(err, {
			requestBody,
			url: `${baseURL}${endpointPath}`,
		});
	}

	// VS Code shows "Sorry, no response was returned" if we emit nothing.
	if (!emitted) {
		callbacks.onTextDelta(sawAnyChunk ? '\n' : 'No response returned by model.');
	}
}

function createProvider(
	providerNpm: string,
	apiKey: string,
	baseURL: string,
	debugLogging?: boolean,
	includeUsage?: boolean,
	sourceMessages?: ModelMessage[]
): (modelId: string) => any {
	switch (providerNpm) {
		case '@ai-sdk/anthropic':
			return createAnthropic({
				apiKey,
				baseURL,
				fetch: debugLogging ? createDebugFetch() : undefined,
			}) as any;
		case '@ai-sdk/openai':
			return createOpenAI({
				apiKey,
				baseURL,
				fetch: debugLogging ? createDebugFetch() : undefined,
			}) as any;
		case '@ai-sdk/google':
			return createGoogleGenerativeAI({
				apiKey,
				baseURL,
				fetch: debugLogging ? createDebugFetch() : undefined,
			}) as any;
		case '@ai-sdk/openai-compatible':
		default:
			return createOpenAICompatible({
				name: OPENAI_COMPAT_PROVIDER_NAME,
				apiKey,
				baseURL,
				fetch: debugLogging ? createDebugFetch() : undefined,
				includeUsage,
				transformRequestBody: (args) =>
					injectOpenAICompatibleReasoningContent(
						applyOpenAICompatibleCaching(args),
						sourceMessages
					),
			});
	}
}


function injectOpenAICompatibleReasoningContent(
	args: Record<string, any>,
	sourceMessages?: ModelMessage[]
): Record<string, any> {
	if (!sourceMessages || sourceMessages.length === 0 || !Array.isArray(args.messages)) {
		return args;
	}

	const sourceAssistantMessages = sourceMessages.filter((message) => message?.role === 'assistant');
	if (sourceAssistantMessages.length === 0) {
		return args;
	}

	let sourceAssistantIndex = 0;
	let changed = false;

	const messages = args.messages.map((requestMessage: unknown) => {
		if (!requestMessage || typeof requestMessage !== 'object') {
			return requestMessage;
		}

		const record = requestMessage as Record<string, any>;
		if (record.role !== 'assistant') {
			return requestMessage;
		}

		const sourceMessage = sourceAssistantMessages[sourceAssistantIndex++];
		const reasoningContent = getReasoningContentFromSourceMessage(sourceMessage);
		if (!reasoningContent) {
			return requestMessage;
		}

		// DeepSeek V4 thinking mode requires this exact field to be replayed on
		// later requests. The AI SDK's OpenAI-compatible adapter may drop custom
		// fields from ModelMessage, so we re-inject it at the final HTTP body stage.
		if (record.reasoning_content === reasoningContent) {
			return requestMessage;
		}

		changed = true;
		return {
			...record,
			reasoning_content: reasoningContent,
		};
	});

	return changed ? { ...args, messages } : args;
}

function getReasoningContentFromSourceMessage(message: unknown): string | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}

	const record = message as Record<string, any>;
	const direct = record.reasoning_content ?? record.reasoningContent;
	if (typeof direct === 'string' && direct.trim().length > 0) {
		return direct;
	}

	// Defensive fallbacks for future/provider-specific shapes.
	const providerOptions = record.providerOptions ?? record.provider_options;
	const candidates = [
		providerOptions?.[OPENAI_COMPAT_PROVIDER_NAME]?.reasoning_content,
		providerOptions?.openaiCompatible?.reasoning_content,
		providerOptions?.opencode?.reasoning_content,
		providerOptions?.['opencode-zen']?.reasoning_content,
	];

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim().length > 0) {
			return candidate;
		}
	}

	return undefined;
}

function applyOpenAICompatibleCaching(args: Record<string, any>): Record<string, any> {
	const modelId = typeof args.model === 'string' ? args.model.toLowerCase() : '';
	const providerOptions = extractCompatibleProviderOptions(args);
	const isGlm47 = modelId === 'glm-4.7' || modelId.endsWith('/glm-4.7');
	if (isGlm47) {
		const hasCacheKey =
			args.prompt_cache_key !== undefined || providerOptions?.prompt_cache_key !== undefined;
		const hasRetention =
			args.prompt_cache_retention !== undefined || providerOptions?.prompt_cache_retention !== undefined;
		if (!hasCacheKey && !hasRetention) {
			return args;
		}
		const sanitizedProviderOptions =
			providerOptions && typeof providerOptions === 'object'
				? {
						...providerOptions,
						prompt_cache_key: undefined,
						prompt_cache_retention: undefined,
					}
				: providerOptions;
		return {
			...args,
			prompt_cache_key: undefined,
			prompt_cache_retention: undefined,
			provider_options:
				sanitizedProviderOptions && args.provider_options && typeof args.provider_options === 'object'
					? {
							...(args.provider_options as Record<string, any>),
							[OPENAI_COMPAT_PROVIDER_NAME]: sanitizedProviderOptions,
						}
					: args.provider_options,
		};
	}
	const cacheKey = args.prompt_cache_key ?? providerOptions?.prompt_cache_key;
	const retention = args.prompt_cache_retention ?? providerOptions?.prompt_cache_retention;

	if (!cacheKey && !retention) {
		return args;
	}

	return {
		...args,
		prompt_cache_key: cacheKey ?? args.prompt_cache_key,
		prompt_cache_retention: retention ?? args.prompt_cache_retention,
	};
}

function extractCompatibleProviderOptions(args: Record<string, any>): Record<string, any> | undefined {
	const snake = args?.provider_options;
	const camel = args?.providerOptions;

	const candidates = [
		snake?.[OPENAI_COMPAT_PROVIDER_NAME],
		snake?.openaiCompatible,
		snake?.opencode,
		snake?.['opencode-zen'],
		camel?.[OPENAI_COMPAT_PROVIDER_NAME],
		camel?.openaiCompatible,
		camel?.opencode,
		camel?.['opencode-zen'],
	];

	for (const candidate of candidates) {
		if (candidate && typeof candidate === 'object') {
			return candidate as Record<string, any>;
		}
	}

	return undefined;
}

function extractCachedTokens(usage: any): { read?: number; write?: number; cached?: number } | undefined {
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}
	const cached =
		usage?.prompt_tokens_details?.cached_tokens ??
		usage?.input_tokens_details?.cached_tokens ??
		usage?.cached_tokens;
	const read = usage?.cache_read_input_tokens ?? usage?.cache_read_tokens;
	const write = usage?.cache_creation_input_tokens ?? usage?.cache_write_tokens;
	if (cached == null && read == null && write == null) {
		return undefined;
	}
	return { cached, read, write };
}

function getEndpointPath(providerNpm: string): string {
	if (providerNpm === '@ai-sdk/anthropic') {
		return '/messages';
	}
	if (providerNpm === '@ai-sdk/openai') {
		return '/responses';
	}
	if (providerNpm === '@ai-sdk/google') {
		return '/v1beta/models';
	}
	return '/chat/completions';
}

function createDebugFetch(): typeof fetch {
	const output = getOutputChannel();

	return async (input, init) => {
		const requestInfo = await serializeRequest(input, init);
		output.info('Debug: HTTP request');
		output.append(`\n${requestInfo}\n`);

		const response = await fetch(input, init);
		const responseInfo = await serializeResponse(response);

		if (!response.ok) {
			output.error('Debug: HTTP response (non-OK)');
			output.append(`\n${responseInfo}\n`);
		} else {
			output.info('Debug: HTTP response');
			output.append(`\n${responseInfo}\n`);
		}

		return response;
	};
}

async function serializeRequest(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1]
): Promise<string> {
	const request = new Request(input, init);
	const headers = redactHeaders(request.headers);
	let body: string | undefined;
	try {
		body = await request.clone().text();
	} catch {
		body = undefined;
	}

	return safeJson({
		method: request.method,
		url: request.url,
		headers,
		body: body && body.length > 0 ? body : undefined,
	});
}

async function serializeResponse(response: Response): Promise<string> {
	let bodyText: string | undefined;
	try {
		bodyText = await response.clone().text();
	} catch {
		bodyText = undefined;
	}

	return safeJson({
		status: response.status,
		statusText: response.statusText,
		url: response.url,
		headers: redactHeaders(response.headers),
		body: bodyText && bodyText.length > 0 ? bodyText : undefined,
	});
}

function redactHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		const lower = key.toLowerCase();
		if (lower === 'authorization' || lower === 'x-api-key') {
			out[key] = '[REDACTED]';
			continue;
		}
		out[key] = value;
	}
	return out;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}
