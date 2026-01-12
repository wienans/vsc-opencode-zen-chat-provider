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
exports.ModelRegistry = void 0;
const vscode = __importStar(require("vscode"));
const MODELS_DEV_URL = 'https://models.dev/api.json';
const PROVIDER_ID = 'opencode';
class ModelRegistry {
    context;
    _onDidChange = new vscode.EventEmitter();
    onDidChange = this._onDidChange.event;
    cachedAtMs;
    cachedModels;
    constructor(context) {
        this.context = context;
    }
    invalidate() {
        this.cachedAtMs = undefined;
        this.cachedModels = undefined;
        this._onDidChange.fire();
    }
    async getModels(options = {}) {
        const ttlMinutes = this.context.workspaceState.get('opencodeZen.modelCacheTtlMinutes.override')
            ?? vscode.workspace.getConfiguration('opencodeZen').get('modelCacheTtlMinutes', 15);
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
        const json = (await response.json());
        const provider = json[PROVIDER_ID];
        if (!provider) {
            throw new Error(`Provider '${PROVIDER_ID}' not found in models.dev api.json`);
        }
        const models = Object.values(provider.models)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((m) => this.toChatInfo(provider, m));
        this.cachedModels = models;
        this.cachedAtMs = now;
        return models;
    }
    toChatInfo(provider, model) {
        const maxInputTokens = model.limit?.context ?? 32_768;
        const maxOutputTokens = model.limit?.output ?? 8_192;
        const costIn = model.cost?.input;
        const costOut = model.cost?.output;
        const tooltipBits = [
            provider.name,
            model.reasoning ? 'Reasoning' : undefined,
            model.tool_call ? 'Tool calling' : undefined,
            costIn !== undefined && costOut !== undefined ? `Cost (per 1M tokens): in $${costIn}, out $${costOut}` : undefined,
        ].filter((x) => Boolean(x));
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
exports.ModelRegistry = ModelRegistry;
//# sourceMappingURL=modelRegistry.js.map