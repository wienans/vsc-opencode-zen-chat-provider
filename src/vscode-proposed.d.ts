// Minimal proposed API declarations for LanguageModelThinkingPart.
// See: https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts

declare module 'vscode' {
	/**
	 * A language model response part containing thinking/reasoning content.
	 * Thinking tokens represent the model's internal reasoning process that
	 * typically streams before the final response.
	 */
	export class LanguageModelThinkingPart {
		value: string | string[];
		id?: string;
		metadata?: { readonly [key: string]: any };
		constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: any });
	}

	/**
	 * Extended response part union that includes thinking content.
	 */
	export type LanguageModelResponsePart2 =
		| LanguageModelTextPart
		| LanguageModelToolResultPart
		| LanguageModelToolCallPart
		| LanguageModelDataPart
		| LanguageModelThinkingPart;
}
