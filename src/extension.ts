import * as vscode from 'vscode';
import { OpenCodeZenChatProvider, VENDOR_ID } from './provider';
import { clearApiKey, setApiKey } from './secrets';

const SELF_TEST_TOOL_NAME = 'opencodeZen.selfTest.getTime';

export function activate(context: vscode.ExtensionContext) {
	const provider = new OpenCodeZenChatProvider(context);
	const output = vscode.window.createOutputChannel('OpenCode Zen', { log: true });

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
				vscode.window.showErrorMessage('No OpenCode Zen models available. Set API key and refresh models.');
				return;
			}

			const picked = await vscode.window.showQuickPick(
				availableModels.map((m) => ({ label: m.name, description: m.id, model: m })),
				{ title: 'Select an OpenCode Zen model for self-test' }
			);
			if (!picked) {
				return;
			}

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
			try {
				await runToolLoop(picked.model, messages, tool, output, cts.token);
				output.info('Self-test completed.');
			} catch (err) {
				output.error(`Self-test failed: ${err instanceof Error ? err.message : String(err)}`);
				throw err;
			} finally {
				cts.dispose();
			}
		})
	);
}

async function runToolLoop(
	model: vscode.LanguageModelChat,
	messages: vscode.LanguageModelChatMessage[],
	tool: vscode.LanguageModelChatTool,
	output: vscode.LogOutputChannel,
	token: vscode.CancellationToken
): Promise<void> {
	for (let i = 0; i < 5; i++) {
		const response = await model.sendRequest(
			messages,
			{
				justification: 'OpenCode Zen self-test: verify streaming + tool calling.',
				tools: [tool],
				toolMode: vscode.LanguageModelChatToolMode.Required,
			},
			token
		);

		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart> = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];

		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				assistantParts.push(part);
				output.append(part.value);
				continue;
			}

			if (part instanceof vscode.LanguageModelToolCallPart) {
				assistantParts.push(part);
				toolCalls.push(part);
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
