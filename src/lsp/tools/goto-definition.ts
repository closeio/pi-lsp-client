import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { withLspClient } from "../client-wrapper.js";
import { formatLocationWithSource, type SourceLineCache } from "../formatters.js";
import { getManagerForSession } from "../manager-registry.js";
import {
	formatSymbolCandidates,
	resolveSymbolPosition,
	resolveWorkspaceContextFile,
	type SymbolResolutionResult,
} from "../symbol-resolution.js";
import type { Location, LocationLink } from "../types.js";
import { handleMissingDependencyError } from "../utils.js";

const Params = Type.Object({
	symbol: Type.Optional(
		Type.String({
			description:
				"Symbol name (e.g. 'renderDiffMap' or 'LspManager.getClient'). Alternative to line/character - resolves the symbol definition automatically in one call.",
		}),
	),
	filePath: Type.Optional(
		Type.String({
			description:
				"Path to the source file. Required with line/character; optional with symbol (narrows lookup or selects the language server in polyglot repos).",
		}),
	),
	line: Type.Optional(
		Type.Number({ description: "1-based line number of the symbol (required unless symbol is provided)" }),
	),
	character: Type.Optional(
		Type.Number({ description: "0-based column of the symbol on that line (required unless symbol is provided)" }),
	),
});

export interface LspGotoDefinitionDetails {
	symbol?: string;
	filePath?: string;
	line?: number;
	character?: number;
	locations: Array<Location | LocationLink>;
	error?: string;
	errorKind?: "missing_dependency" | "invalid_params" | "not_found";
}

function baseDetails(params: {
	symbol?: string;
	filePath?: string;
	line?: number;
	character?: number;
}): Pick<LspGotoDefinitionDetails, "symbol" | "filePath" | "line" | "character"> {
	return {
		...(params.symbol !== undefined ? { symbol: params.symbol } : {}),
		...(params.filePath !== undefined ? { filePath: params.filePath } : {}),
		...(params.line !== undefined ? { line: params.line } : {}),
		...(params.character !== undefined ? { character: params.character } : {}),
	};
}

export const lsp_goto_definition = defineTool({
	name: "lsp_goto_definition",
	label: "LSP Goto Definition",
	description:
		"Jump to symbol definition. Find WHERE something is defined. " +
		"Pass symbol (with optional filePath) for one-step lookup, or filePath + line + character.",
	promptSnippet: "Jump to a symbol's definition by name or position (includes source line)",
	promptGuidelines: [
		"Prefer lsp_goto_definition(symbol=...) over grep when locating where a symbol is defined - no prior grep or line/column lookup needed.",
	],
	parameters: Params,
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const manager = getManagerForSession(ctx.sessionManager);
		const symbol = params.symbol?.trim() || undefined;
		const hasPosition = params.filePath !== undefined && params.line !== undefined && params.character !== undefined;

		if (!hasPosition && !symbol) {
			const text = "Provide either symbol (with optional filePath) or filePath + line + character.";
			return {
				content: [{ type: "text", text }],
				details: {
					...baseDetails(params),
					locations: [],
					error: text,
					errorKind: "invalid_params",
				} satisfies LspGotoDefinitionDetails,
			};
		}

		const lineCache: SourceLineCache = new Map();

		try {
			const contextFile = params.filePath ?? resolveWorkspaceContextFile(ctx.cwd);
			if (!contextFile) {
				const text =
					"Could not infer a configured language server for this workspace. Pass filePath alongside symbol.";
				return {
					content: [{ type: "text", text }],
					details: {
						...baseDetails(params),
						locations: [],
						error: text,
						errorKind: "invalid_params",
					} satisfies LspGotoDefinitionDetails,
				};
			}

			type QueryOutcome =
				| {
						kind: "locations";
						locations: Array<Location | LocationLink>;
						resolvedFilePath?: string;
						resolvedLine?: number;
						resolvedCharacter?: number;
				  }
				| {
						kind: "not_found";
						suggestions: Extract<SymbolResolutionResult, { status: "not_found" }>["suggestions"];
				  };

			const outcome = await withLspClient<QueryOutcome>(
				contextFile,
				async (client) => {
					if (
						hasPosition &&
						params.filePath !== undefined &&
						params.line !== undefined &&
						params.character !== undefined
					) {
						const result = await client.definition(params.filePath, params.line, params.character, signal);
						const locations = !result ? [] : Array.isArray(result) ? result : [result];
						return {
							kind: "locations",
							locations,
							resolvedFilePath: params.filePath,
							resolvedLine: params.line,
							resolvedCharacter: params.character,
						};
					}

					const resolution = await resolveSymbolPosition(client, symbol as string, {
						...(params.filePath !== undefined ? { filePath: params.filePath } : {}),
						...(signal !== undefined ? { signal } : {}),
						allowFileUsageFallback: params.filePath !== undefined,
						lineCache,
					});

					if (resolution.status === "not_found") {
						return { kind: "not_found", suggestions: resolution.suggestions };
					}

					if (resolution.status === "ambiguous") {
						return {
							kind: "locations",
							locations: resolution.matches.map((m) => m.location),
							...(params.filePath !== undefined ? { resolvedFilePath: params.filePath } : {}),
						};
					}

					const { target } = resolution;
					const result = await client.definition(target.filePath, target.line, target.character, signal);
					const locations = !result ? [] : Array.isArray(result) ? result : [result];
					return {
						kind: "locations",
						locations: locations.length > 0 ? locations : target.fromUsage ? [] : [target.location],
						resolvedFilePath: target.filePath,
						resolvedLine: target.line,
						resolvedCharacter: target.character,
					};
				},
				"definition",
				{ manager, onUpdate, ...(signal === undefined ? {} : { signal }) },
			);

			if (outcome.kind === "not_found") {
				const hint =
					outcome.suggestions.length > 0
						? `\nDid you mean:\n${formatSymbolCandidates(outcome.suggestions, lineCache)}`
						: "";
				const text = `Symbol '${symbol}' not found.${hint}`;
				return {
					content: [{ type: "text", text }],
					details: {
						...baseDetails(params),
						locations: [],
						error: text,
						errorKind: "not_found",
					} satisfies LspGotoDefinitionDetails,
				};
			}

			const { locations } = outcome;
			if (locations.length === 0) {
				return {
					content: [{ type: "text", text: "No definition found" }],
					details: {
						...(symbol !== undefined ? { symbol } : {}),
						...(outcome.resolvedFilePath !== undefined ? { filePath: outcome.resolvedFilePath } : {}),
						...(outcome.resolvedLine !== undefined ? { line: outcome.resolvedLine } : {}),
						...(outcome.resolvedCharacter !== undefined ? { character: outcome.resolvedCharacter } : {}),
						locations: [],
					} satisfies LspGotoDefinitionDetails,
				};
			}

			const text = locations.map((loc) => formatLocationWithSource(loc, lineCache)).join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					...(symbol !== undefined ? { symbol } : {}),
					...(outcome.resolvedFilePath !== undefined ? { filePath: outcome.resolvedFilePath } : {}),
					...(outcome.resolvedLine !== undefined ? { line: outcome.resolvedLine } : {}),
					...(outcome.resolvedCharacter !== undefined ? { character: outcome.resolvedCharacter } : {}),
					locations,
				} satisfies LspGotoDefinitionDetails,
			};
		} catch (e) {
			const message = handleMissingDependencyError(e);
			if (message) {
				return {
					content: [{ type: "text", text: message }],
					details: {
						...baseDetails(params),
						locations: [],
						error: message,
						errorKind: "missing_dependency",
					} satisfies LspGotoDefinitionDetails,
				};
			}
			throw e;
		}
	},
});
