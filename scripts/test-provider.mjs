import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const originalLoad = Module._load;

class DataPart {
    constructor(data, mimeType) {
        this.data = data;
        if (mimeType !== undefined) {
            this.mimeType = mimeType;
        }
    }
}
class TextPart {
    constructor(value) {
        this.value = value;
    }
}
class PromptTsxPart {
    constructor(value) {
        this.value = value;
    }
}
class ToolCallPart {}
class ToolResultPart {}
class ThinkingPart {}

const vscodeShim = {
    LanguageModelDataPart: DataPart,
    LanguageModelTextPart: TextPart,
    LanguageModelPromptTsxPart: PromptTsxPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelThinkingPart: ThinkingPart,
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    workspace: {
        getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    window: {
        createOutputChannel: () => ({
            debug() {},
            info() {},
            warn() {},
            error() {},
            dispose() {},
        }),
    },
};

Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
        return vscodeShim;
    }
    return originalLoad.call(this, request, parent, isMain);
};

try {
    const {
        dataPartToAiSdkPart,
        languageModelToolResultContentToOutput,
        normalizeRequestToolMode,
    } = require("../out/provider.js");

    const missingMimePart = new DataPart(new Uint8Array([1, 2]));
    assert.equal("mimeType" in missingMimePart, false);
    assert.equal(dataPartToAiSdkPart(missingMimePart), undefined);
    assert.deepEqual(
        dataPartToAiSdkPart(new DataPart(new globalThis.TextEncoder().encode("hello"), "text/plain")),
        { type: "text", text: "hello" },
    );
    assert.deepEqual(
        languageModelToolResultContentToOutput([missingMimePart, new TextPart("kept")]),
        { type: "text", value: "kept" },
    );

    assert.equal(normalizeRequestToolMode("x-preview-f-free", "required"), "auto");
    assert.equal(normalizeRequestToolMode("big-pickle", "required"), "auto");
    assert.equal(normalizeRequestToolMode("gpt-5.6-luna", "required"), "required");

    globalThis.console.log("zen provider compatibility: ok");
} finally {
    Module._load = originalLoad;
}
