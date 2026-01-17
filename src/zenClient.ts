import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, type CoreMessage } from 'ai';

export const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';

export type ToolMode = 'auto' | 'required';

export type StreamCallbacks = {
	onTextDelta: (delta: string) => void;
	onToolCall: (args: { toolCallId: string; toolName: string; input: object }) => void;
};

function wrapApiError(err: unknown): Error {
	if (err instanceof Error) {
		const msg = err.message;
		if (msg.includes('Unauthorized') || msg.includes('401')) {
			return new Error('Unauthorized: Please check your OpenCode API key. Run "OpenCode Zen: Set API Key" to update it.');
		}
		if (msg.includes('404') || msg.includes('Not Found')) {
			return new Error(`Model not found. The requested model may not be available.`);
		}
		return err;
	}
	return new Error(String(err));
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
				throw wrapApiError(part.error);
			}

			// Ignore finish/metadata parts.
		}
	} catch (err) {
		throw wrapApiError(err);
	}

	// VS Code shows "Sorry, no response was returned" if we emit nothing.
	if (!emitted) {
		callbacks.onTextDelta(sawAnyChunk ? '\n' : 'No response returned by model.');
	}
}
