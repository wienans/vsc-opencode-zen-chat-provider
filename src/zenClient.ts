import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, type CoreMessage } from 'ai';

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

export type ToolMode = 'auto' | 'required';

export type StreamCallbacks = {
	onTextDelta: (delta: string) => void;
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

export async function streamZen(
	options: {
		apiKey: string;
		modelId: string;
		messages: CoreMessage[];
		tools?: Record<string, any>;
		toolMode: ToolMode;
		abortSignal: AbortSignal;
		modelOptions?: Record<string, any>;
	},
	callbacks: StreamCallbacks
): Promise<void> {
	if (!options.apiKey || options.apiKey.trim() === '') {
		throw new Error('OpenCode Zen API key is empty. Run "OpenCode Zen: Set API Key" to configure it.');
	}

	const zen = createOpenAICompatible({
		name: 'opencode-zen',
		apiKey: options.apiKey,
		baseURL: ZEN_BASE_URL,
	});

	const result = streamText({
		model: zen(options.modelId),
		messages: options.messages,
		tools: options.tools,
		toolChoice: options.tools ? options.toolMode : undefined,
		abortSignal: options.abortSignal,
		providerOptions: options.modelOptions,
		// Avoid tool-call streaming deltas; we want complete tool calls.
		toolCallStreaming: false,
	});

	const requestBody: Record<string, unknown> = {
		model: options.modelId,
		messages: options.messages,
		tools: options.tools,
		tool_choice: options.tools ? options.toolMode : undefined,
		provider_options: options.modelOptions ?? undefined,
	};

	let emitted = false;
	let sawAnyChunk = false;

	try {
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
					input: (part.args ?? {}) as object,
				});
				continue;
			}

			if (part.type === 'error') {
				throw wrapApiError(part.error, {
					requestBody,
					url: `${ZEN_BASE_URL}/chat/completions`,
				});
			}

			// Ignore finish/metadata parts.
		}
	} catch (err) {
		throw wrapApiError(err, {
			requestBody,
			url: `${ZEN_BASE_URL}/chat/completions`,
		});
	}

	// VS Code shows "Sorry, no response was returned" if we emit nothing.
	if (!emitted) {
		callbacks.onTextDelta(sawAnyChunk ? '\n' : 'No response returned by model.');
	}
}
