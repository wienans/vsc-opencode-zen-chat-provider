import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;

export function getOutputChannel(): vscode.LogOutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('OpenCode Zen', { log: true });
	}
	return outputChannel;
}
