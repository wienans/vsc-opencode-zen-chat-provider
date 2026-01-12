import type * as vscode from 'vscode';

const SECRET_KEY = 'opencodeZen.apiKey';

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
	const stored = await secrets.get(SECRET_KEY);
	return stored ?? undefined;
}

export async function setApiKey(secrets: vscode.SecretStorage, apiKey: string): Promise<void> {
	await secrets.store(SECRET_KEY, apiKey);
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
	await secrets.delete(SECRET_KEY);
}
