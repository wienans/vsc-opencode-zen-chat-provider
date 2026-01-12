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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const provider_1 = require("./provider");
const secrets_1 = require("./secrets");
const SELF_TEST_TOOL_NAME = 'opencodeZen.selfTest.getTime';
function activate(context) {
    const provider = new provider_1.OpenCodeZenChatProvider(context);
    const output = vscode.window.createOutputChannel('OpenCode Zen', { log: true });
    context.subscriptions.push(output, vscode.lm.registerLanguageModelChatProvider(provider_1.VENDOR_ID, provider), vscode.commands.registerCommand('opencodeZen.setApiKey', async () => {
        const key = await vscode.window.showInputBox({
            prompt: 'Enter your OpenCode API key (OPENCODE_API_KEY)',
            password: true,
            ignoreFocusOut: true,
        });
        if (!key) {
            return;
        }
        await (0, secrets_1.setApiKey)(context.secrets, key);
        vscode.window.showInformationMessage('OpenCode Zen API key saved.');
        provider.refreshModels();
    }), vscode.commands.registerCommand('opencodeZen.clearApiKey', async () => {
        await (0, secrets_1.clearApiKey)(context.secrets);
        vscode.window.showInformationMessage('OpenCode Zen API key cleared.');
        provider.refreshModels();
    }), vscode.commands.registerCommand('opencodeZen.refreshModels', async () => {
        await provider.refreshModels(true);
        vscode.window.showInformationMessage('OpenCode Zen model list refreshed.');
    }), vscode.commands.registerCommand('opencodeZen.selfTest', async () => {
        output.clear();
        output.show(true);
        output.info('Starting OpenCode Zen self-test...');
        const availableModels = await vscode.lm.selectChatModels({ vendor: provider_1.VENDOR_ID });
        if (availableModels.length === 0) {
            vscode.window.showErrorMessage('No OpenCode Zen models available. Set API key and refresh models.');
            return;
        }
        const picked = await vscode.window.showQuickPick(availableModels.map((m) => ({ label: m.name, description: m.id, model: m })), { title: 'Select an OpenCode Zen model for self-test' });
        if (!picked) {
            return;
        }
        const tool = {
            name: SELF_TEST_TOOL_NAME,
            description: 'Returns the current time. Input: { tz?: string }',
            inputSchema: {
                type: 'object',
                properties: { tz: { type: 'string', description: 'IANA time zone, optional' } },
                additionalProperties: false,
            },
        };
        const messages = [
            vscode.LanguageModelChatMessage.User('Call the provided tool once, then explain what you did in one short paragraph.'),
        ];
        const cts = new vscode.CancellationTokenSource();
        try {
            await runToolLoop(picked.model, messages, tool, output, cts.token);
            output.info('Self-test completed.');
        }
        catch (err) {
            output.error(`Self-test failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
        finally {
            cts.dispose();
        }
    }));
}
async function runToolLoop(model, messages, tool, output, token) {
    for (let i = 0; i < 5; i++) {
        const response = await model.sendRequest(messages, {
            justification: 'OpenCode Zen self-test: verify streaming + tool calling.',
            tools: [tool],
            toolMode: vscode.LanguageModelChatToolMode.Required,
        }, token);
        const assistantParts = [];
        const toolCalls = [];
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
            const input = (call.input ?? {});
            const now = input.tz ? new Date().toLocaleString('en-US', { timeZone: input.tz }) : new Date().toISOString();
            const content = [new vscode.LanguageModelTextPart(now)];
            messages.push(vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, content)]));
            output.info(`Tool result sent for ${call.callId}.`);
        }
    }
    throw new Error('Self-test exceeded max tool-call iterations (5).');
}
function deactivate() { }
//# sourceMappingURL=extension.js.map