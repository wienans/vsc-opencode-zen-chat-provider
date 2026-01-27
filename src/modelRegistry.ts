import * as vscode from 'vscode';

export type ModelsDevProvider = {
	id: string;
	name: string;
	env: string[];
	npm: string;
	api: string;
	doc: string;
	models: Record<string, ModelsDevModel>;
};

export type ModelsDevModelProvider = {
	npm?: string;
};

export type ModelsDevModel = {
	id: string;
	name: string;
	family: string;
	attachment: boolean;
	reasoning: boolean;
	tool_call: boolean;
	temperature: boolean;
	provider?: ModelsDevModelProvider;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	modalities?: { input?: string[]; output?: string[] };
	open_weights?: boolean;
	cost?: { input?: number; output?: number; cache_read?: number };
	limit?: { context?: number; output?: number };
	status?: string;
};

const MODELS_DEV_URL = 'https://models.dev/api.json';
const PROVIDER_ID = 'opencode';

export class ModelRegistry {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private cachedAtMs: number | undefined;
	private cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private providerDefaults: { npm: string; api: string } | undefined;
	private modelProviderOverrides = new Map<string, string>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	invalidate(): void {
		this.cachedAtMs = undefined;
		this.cachedModels = undefined;
		this.providerDefaults = undefined;
		this.modelProviderOverrides.clear();
		this._onDidChange.fire();
	}

	async getModels(options: { force?: boolean } = {}): Promise<vscode.LanguageModelChatInformation[]> {
		const ttlMinutes = this.context.workspaceState.get<number>('opencodeZen.modelCacheTtlMinutes.override')
			?? vscode.workspace.getConfiguration('opencodeZen').get<number>('modelCacheTtlMinutes', 15);

		const ttlMs = Math.max(0, ttlMinutes) * 60_000;
		const now = Date.now();
		if (!options.force && this.cachedModels && this.cachedAtMs !== undefined) {
			if (ttlMs === 0 || now - this.cachedAtMs < ttlMs) {
				return this.cachedModels;
			}
		}

		const response = await fetch(MODELS_DEV_URL, {
			headers: { 'accept': 'application/json' },
		});
		if (!response.ok) {
			throw new Error(`Failed to fetch models from models.dev: ${response.status} ${response.statusText}`);
		}

		const json = (await response.json()) as Record<string, ModelsDevProvider>;
		const provider = json[PROVIDER_ID];
		if (!provider) {
			throw new Error(`Provider '${PROVIDER_ID}' not found in models.dev api.json`);
		}

		this.providerDefaults = { npm: provider.npm, api: provider.api };
		this.modelProviderOverrides = new Map(
			Object.values(provider.models)
				.filter((m) => Boolean(m.provider?.npm))
				.map((m) => [m.id, m.provider?.npm as string])
		);

		const models = Object.values(provider.models)
			.filter((model) => model.status !== 'deprecated')
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((m) => this.toChatInfo(provider, m));

		this.cachedModels = models;
		this.cachedAtMs = now;
		return models;
	}

	async getModelProviderInfo(modelId: string): Promise<{ npm: string; api: string } | undefined> {
		if (!this.providerDefaults || !this.cachedModels) {
			await this.getModels();
		}

		if (!this.providerDefaults) {
			return undefined;
		}

		const override = this.modelProviderOverrides.get(modelId);
		return {
			npm: override ?? this.providerDefaults.npm,
			api: this.providerDefaults.api,
		};
	}

	private toChatInfo(provider: ModelsDevProvider, model: ModelsDevModel): vscode.LanguageModelChatInformation {
		const maxInputTokens = model.limit?.context ?? 32_768;
		const maxOutputTokens = model.limit?.output ?? 8_192;
		const costIn = model.cost?.input;
		const costOut = model.cost?.output;
		const tooltipBits: string[] = [
			provider.name,
			model.reasoning ? 'Reasoning' : undefined,
			model.tool_call ? 'Tool calling' : undefined,
			costIn !== undefined && costOut !== undefined ? `Cost (per 1M tokens): in $${costIn}, out $${costOut}` : undefined,
		].filter((x): x is string => Boolean(x));

		return {
			id: model.id,
			name: model.name,
			family: model.family,
			version: model.last_updated ?? model.release_date ?? 'unknown',
			tooltip: tooltipBits.join(' • '),
			maxInputTokens,
			maxOutputTokens,
			capabilities: {
				toolCalling: model.tool_call,
				// models.dev uses 'attachment'. We conservatively expose it as imageInput.
				imageInput: model.attachment,
			},
		};
	}
}
