import * as vscode from 'vscode';
import { OpenCodeZenChatProvider, VENDOR_ID } from './provider';
import { getOutputChannel } from './output';
import { clearApiKey, setApiKey } from './secrets';

const SELF_TEST_TOOL_NAME = 'opencodeZen.selfTest.getTime';

export function activate(context: vscode.ExtensionContext) {
	const provider = new OpenCodeZenChatProvider(context);
	const output = getOutputChannel();

	context.subscriptions.push(
		output,
		vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider),
		vscode.commands.registerCommand('opencodeZen.setApiKey', async () => {
			const key = await vscode.window.showInputBox({
				prompt: 'Enter your OpenCode API key (OPENCODE_API_KEY)',
				password: true,
				ignoreFocusOut: true,
			});
			if (!key) {
				return;
			}
			await setApiKey(context.secrets, key);
			vscode.window.showInformationMessage('OpenCode Zen API key saved.');
			provider.refreshModels();
		}),
		vscode.commands.registerCommand('opencodeZen.clearApiKey', async () => {
			await clearApiKey(context.secrets);
			vscode.window.showInformationMessage('OpenCode Zen API key cleared.');
			provider.refreshModels();
		}),
		vscode.commands.registerCommand('opencodeZen.refreshModels', async () => {
			await provider.refreshModels(true);
			vscode.window.showInformationMessage('OpenCode Zen model list refreshed.');
		}),
		vscode.commands.registerCommand('opencodeZen.selfTest', async () => {
			output.clear();
			output.show(true);
			output.info('Starting OpenCode Zen self-test...');

			const availableModels = await vscode.lm.selectChatModels({ vendor: VENDOR_ID });
			if (availableModels.length === 0) {
				output.error('No OpenCode Zen models available. Set API key and refresh models.');
				return;
			}

			const picked = await vscode.window.showQuickPick(
				availableModels.map((m) => ({ label: m.name, description: m.id, model: m })),
				{ title: 'Select an OpenCode Zen model for self-test' }
			);
			if (!picked) {
				return;
			}

			output.info(`Selected model: ${picked.model.name} (${picked.model.id})`);

			const tool: vscode.LanguageModelChatTool = {
				name: SELF_TEST_TOOL_NAME,
				description: 'Returns the current time. Input: { tz?: string }',
				inputSchema: {
					type: 'object',
					properties: { tz: { type: 'string', description: 'IANA time zone, optional' } },
					additionalProperties: false,
				},
			};

			const messages: vscode.LanguageModelChatMessage[] = [
				vscode.LanguageModelChatMessage.User(
					'Call the provided tool once, then explain what you did in one short paragraph.'
				),
			];

			const cts = new vscode.CancellationTokenSource();
			const runContext: SelfTestContext = {
				modelId: picked.model.id,
				modelName: picked.model.name,
				toolName: tool.name,
				toolMode: 'required',
				iteration: 0,
				lastAssistantChars: 0,
			};
			try {
				await runToolLoop(picked.model, messages, tool, output, cts.token, runContext);
				output.info('Self-test completed.');
			} catch (err) {
				logSelfTestFailure(output, err, runContext);
				return;
			} finally {
				cts.dispose();
			}
		})
	);
}

interface SelfTestContext {
	modelId: string;
	modelName: string;
	toolName: string;
	toolMode: 'required' | 'auto';
	iteration: number;
	lastToolCall?: { name: string; callId: string; input?: object };
	lastAssistantSample?: string;
	lastAssistantChars: number;
}

type ErrorDetails = {
	statusCode?: number;
	statusText?: string;
	responseBody?: string;
	requestId?: string;
	url?: string;
	requestBody?: unknown;
	originalMessage?: string;
};

function logSelfTestFailure(output: vscode.LogOutputChannel, err: unknown, context: SelfTestContext): void {
	output.error('Self-test failed.');
	output.info(`Model: ${context.modelName} (${context.modelId})`);
	output.info(`Tool: ${context.toolName} (mode: ${context.toolMode})`);
	output.info(`Iteration: ${context.iteration}`);

	if (context.lastToolCall) {
		const input = context.lastToolCall.input ? safeJson(context.lastToolCall.input) : '(none)';
		output.info(`Last tool call: ${context.lastToolCall.name} (${context.lastToolCall.callId})`);
		output.info(`Last tool input: ${input}`);
	}

	if (context.lastAssistantSample) {
		output.info(`Last assistant output (tail ${context.lastAssistantChars} chars):`);
		output.append(`\n${context.lastAssistantSample}\n`);
	}

	const message = err instanceof Error ? err.message : String(err);
	output.info(`Error message: ${message}`);

	const details = extractErrorDetails(err);
	if (details.originalMessage && details.originalMessage !== message) {
		output.info(`Original error: ${details.originalMessage}`);
	}
	if (details.statusCode) {
		output.info(`Status: ${details.statusCode}${details.statusText ? ` ${details.statusText}` : ''}`);
	}
	if (details.url) {
		output.info(`URL: ${details.url}`);
	}
	if (details.requestId) {
		output.info(`Request ID: ${details.requestId}`);
	}
	if (details.responseBody !== undefined) {
		output.info('Response body (raw):');
		output.append(`\n${details.responseBody}\n`);
	}
	if (details.requestBody !== undefined) {
		output.info('Request body:');
		output.append(`\n${safeJson(details.requestBody)}\n`);
	}

	output.info('Error object (raw):');
	output.append(`\n${safeJson(serializeError(err))}\n`);
}

function extractErrorDetails(err: unknown): ErrorDetails {
	const record = (value: unknown): Record<string, unknown> | undefined => {
		if (value && typeof value === 'object') {
			return value as Record<string, unknown>;
		}
		return undefined;
	};

	const candidates = [record(err), record((err as { cause?: unknown })?.cause)].filter(Boolean) as Record<string, unknown>[];
	const details: ErrorDetails = {};

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

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
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

async function runToolLoop(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	tool: vscode.LanguageModelChatTool,
	output: vscode.LogOutputChannel,
	token: vscode.CancellationToken,
	context: SelfTestContext
): Promise<void> {
	for (let i = 0; i < 5; i++) {
		context.iteration = i + 1;
		output.info(`Self-test iteration ${context.iteration}...`);

		const response = await model.sendRequest(
			messages,
			{
				justification: 'OpenCode Zen self-test: verify streaming + tool calling.',
				tools: [tool],
				toolMode: vscode.LanguageModelChatToolMode.Required,
				modelOptions: { __opencodeDebugSelfTest: true },
			},
			token
		);

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart> = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let assistantTail = context.lastAssistantSample ?? '';

		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				assistantParts.push(part);
				output.append(part.value);
				if (part.value) {
					assistantTail = (assistantTail + part.value).slice(-1000);
					context.lastAssistantSample = assistantTail;
					context.lastAssistantChars = assistantTail.length;
				}
				continue;
			}

			if (part instanceof vscode.LanguageModelToolCallPart) {
				assistantParts.push(part);
				toolCalls.push(part);
				context.lastToolCall = { name: part.name, callId: part.callId, input: part.input as object | undefined };
				output.info(`\nTool call requested: ${part.name} (${part.callId})`);
				continue;
			}

			if (part instanceof vscode.LanguageModelDataPart) {
				assistantParts.push(part);
				continue;
			}
		}

		messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

		if (toolCalls.length === 0) {
			return;
		}

		for (const call of toolCalls) {
			if (call.name !== SELF_TEST_TOOL_NAME) {
				throw new Error(`Unexpected tool call: ${call.name}`);
			}

			const input = (call.input ?? {}) as { tz?: string };
			const now = input.tz ? new Date().toLocaleString('en-US', { timeZone: input.tz }) : new Date().toISOString();
			const content = [new vscode.LanguageModelTextPart(now)];
			messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, content)]));
			output.info(`Tool result sent for ${call.callId}.`);
		}
	}

	throw new Error('Self-test exceeded max tool-call iterations (5).');
}

export function deactivate() {}
