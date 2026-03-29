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

export type ModelsDevModelStatus = 'active' | 'beta' | 'deprecated';

export type ModelsDevModel = {
	id: string;
	name: string;
	family: string;
	attachment: boolean;
	reasoning: boolean;
	tool_call: boolean;
	temperature: boolean;
	headers?: Record<string, string>;
	options?: Record<string, unknown>;
	provider?: ModelsDevModelProvider;
	knowledge?: string;
	release_date?: string;
	last_updated?: string;
	modalities?: { input?: string[]; output?: string[] };
	open_weights?: boolean;
	cost?: { input?: number; output?: number; cache_read?: number };
	limit?: { context?: number; output?: number };
	status?: ModelsDevModelStatus;
};

const MODELS_DEV_URL = 'https://models.dev/api.json';
const PROVIDER_IDS = ['opencode', 'opencode-go'] as const;

const OPENCODE_GO_NPM_OVERRIDES: Record<string, string> = {
	'minimax-m2.7': '@ai-sdk/openai-compatible',
	'minimax-m2.5': '@ai-sdk/openai-compatible',
};

// Note: models.dev says minimax models use @ai-sdk/anthropic (routes to /messages endpoint),
// but that endpoint returns "Missing API key" errors. The /chat/completions endpoint works,
// so we override to @ai-sdk/openai-compatible for these models.

export class ModelRegistry {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	private cachedAtMs: number | undefined;
	private cachedModels: vscode.LanguageModelChatInformation[] | undefined;
	private providerDefaults: Map<string, { npm: string; api: string }> = new Map();
	private modelProviderOverrides = new Map<string, string>();
	private modelRequestMetadata = new Map<string, { headers?: Record<string, string>; options?: Record<string, unknown>; originalModelId?: string }>();
	private modelProviderApi = new Map<string, string>();

	constructor(private readonly context: vscode.ExtensionContext) {}

	invalidate(): void {
		this.cachedAtMs = undefined;
		this.cachedModels = undefined;
		this.providerDefaults.clear();
		this.modelProviderOverrides.clear();
		this.modelRequestMetadata.clear();
		this.modelProviderApi.clear();
		this._onDidChange.fire();
	}

	async getModels(options: { force?: boolean; hasKey?: boolean } = {}): Promise<vscode.LanguageModelChatInformation[]> {
		const ttlMinutes = this.context.workspaceState.get<number>('opencodeZen.modelCacheTtlMinutes.override')
			?? vscode.workspace.getConfiguration('opencodeZen').get<number>('modelCacheTtlMinutes', 60);

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

		this.providerDefaults.clear();
		this.modelProviderOverrides.clear();
		this.modelRequestMetadata.clear();
		this.modelProviderApi.clear();

		const allModels: { provider: ModelsDevProvider; model: ModelsDevModel; providerId: string; uniqueId: string }[] = [];

		for (const providerId of PROVIDER_IDS) {
			const provider = json[providerId];
			if (!provider) {
				continue;
			}

			this.providerDefaults.set(providerId, { npm: provider.npm, api: provider.api });

			for (const model of Object.values(provider.models)) {
				const uniqueId = providerId === 'opencode-go' ? `${model.id}-go` : model.id;
				if (this.modelProviderApi.get(uniqueId) === undefined) {
					this.modelProviderApi.set(uniqueId, providerId);
					allModels.push({ provider, model, providerId, uniqueId });

					const npmOverride = providerId === 'opencode-go' ? OPENCODE_GO_NPM_OVERRIDES[model.id] : undefined;
					if (npmOverride) {
						this.modelProviderOverrides.set(uniqueId, npmOverride);
					} else if (model.provider?.npm) {
						this.modelProviderOverrides.set(uniqueId, model.provider.npm);
					}
				}

				this.modelRequestMetadata.set(uniqueId, {
					headers: model.headers,
					options: model.options,
					originalModelId: model.id,
				});
			}
		}

		if (this.providerDefaults.size === 0) {
			throw new Error(`No valid providers (${PROVIDER_IDS.join(', ')}) found in models.dev`);
		}

		const isActiveModel = (model: ModelsDevModel) => model.status === undefined || model.status !== 'deprecated';
		const hasKey = options.hasKey ?? true;
		const models = allModels
			.filter(({ model }) => isActiveModel(model))
			.filter(({ model }) => hasKey || model.cost?.input === 0)
			.sort((a, b) => a.model.name.localeCompare(b.model.name))
			.map(({ provider, model, providerId, uniqueId }) => this.toChatInfo(provider, model, providerId, uniqueId));

		this.cachedModels = models;
		this.cachedAtMs = now;
		return models;
	}

	async getModelProviderInfo(modelId: string): Promise<{ npm: string; api: string; headers?: Record<string, string>; options?: Record<string, unknown>; originalModelId?: string } | undefined> {
		if (!this.cachedModels) {
			await this.getModels();
		}

		if (this.providerDefaults.size === 0) {
			return undefined;
		}

		const override = this.modelProviderOverrides.get(modelId);
		const metadata = this.modelRequestMetadata.get(modelId);
		const providerId = this.modelProviderApi.get(modelId);
		if (!providerId) {
			return undefined;
		}
		const providerInfo = this.providerDefaults.get(providerId);

		return {
			npm: override ?? providerInfo?.npm ?? 'unknown',
			api: providerInfo?.api ?? 'unknown',
			headers: metadata?.headers,
			options: metadata?.options,
			originalModelId: metadata?.originalModelId,
		};
	}

	private toChatInfo(provider: ModelsDevProvider, model: ModelsDevModel, providerId: string, uniqueId: string): vscode.LanguageModelChatInformation {
		const maxInputTokens = model.limit?.context ?? 32_768;
		const maxOutputTokens = model.limit?.output ?? 8_192;
		const costIn = model.cost?.input;
		const costOut = model.cost?.output;
		const isGo = providerId === 'opencode-go';
		const modelName = isGo ? `${model.name} (Go)` : model.name;
		const tooltipBits: string[] = [
			provider.name + (isGo ? ' (Go)' : ''),
			model.reasoning ? 'Reasoning' : undefined,
			model.tool_call ? 'Tool calling' : undefined,
			costIn !== undefined && costOut !== undefined ? `Cost (per 1M tokens): in $${costIn}, out $${costOut}` : undefined,
		].filter((x): x is string => Boolean(x));

		return {
			id: uniqueId,
			name: modelName,
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
