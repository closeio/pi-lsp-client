import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { withLspClient } from "../client-wrapper.js";
import { DEFAULT_MAX_REFERENCES } from "../constants.js";
import { formatLocationWithSource, type SourceLineCache } from "../formatters.js";
import { getManagerForSession } from "../manager-registry.js";
import {
	formatSymbolCandidates,
	resolveSymbolPosition,
	resolveWorkspaceContextFile,
	type SymbolResolutionResult,
} from "../symbol-resolution.js";
import type { Location } from "../types.js";
import { handleMissingDependencyError } from "../utils.js";

const Params = Type.Object({
	symbol: Type.Optional(
		Type.String({
			description:
				"Symbol name (e.g. 'renderDiffMap' or 'LspManager.getClient'). Alternative to line/character - resolves the symbol position automatically in one call.",
		}),
	),
	filePath: Type.Optional(
		Type.String({
			description:
				"Path to the source file. Required with line/character; optional with symbol (narrows lookup or selects the language server in polyglot repos).",
		}),
	),
	line: Type.Optional(Type.Number({ description: "1-based line of the symbol (required unless symbol is provided)" })),
	character: Type.Optional(
		Type.Number({ description: "0-based column of the symbol on that line (required unless symbol is provided)" }),
	),
	includeDeclaration: Type.Optional(Type.Boolean({ description: "Include the declaration itself (default: true)" })),
});

export interface LspFindReferencesDetails {
	symbol?: string;
	filePath?: string;
	line?: number;
	character?: number;
	references: Location[];
	totalReferences: number;
	truncated: boolean;
	error?: string;
	errorKind?: "missing_dependency" | "invalid_params" | "not_found" | "ambiguous";
}

function baseDetails(params: {
	symbol?: string;
	filePath?: string;
	line?: number;
	character?: number;
}): Pick<LspFindReferencesDetails, "symbol" | "filePath" | "line" | "character"> {
	return {
		...(params.symbol !== undefined ? { symbol: params.symbol } : {}),
		...(params.filePath !== undefined ? { filePath: params.filePath } : {}),
		...(params.line !== undefined ? { line: params.line } : {}),
		...(params.character !== undefined ? { character: params.character } : {}),
	};
}

export const lsp_find_references = defineTool({
	name: "lsp_find_references",
	label: "LSP Find References",
	description:
		"Find ALL usages/references of a symbol across the entire workspace. " +
		"Pass symbol (with optional filePath) for one-step lookup, or filePath + line + character.",
	promptSnippet: "Find all workspace references to a symbol by name or position (includes source lines)",
	promptGuidelines: [
		"Prefer lsp_find_references(symbol=...) over grep when enumerating callers or usages of a symbol - no prior grep or line/column lookup needed.",
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
					references: [],
					totalReferences: 0,
					truncated: false,
					error: text,
					errorKind: "invalid_params",
				} satisfies LspFindReferencesDetails,
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
						references: [],
						totalReferences: 0,
						truncated: false,
						error: text,
						errorKind: "invalid_params",
					} satisfies LspFindReferencesDetails,
				};
			}

			type QueryOutcome =
				| {
						kind: "references";
						references: Location[];
						resolvedFilePath: string;
						resolvedLine: number;
						resolvedCharacter: number;
						resolvedNote?: string;
				  }
				| { kind: "unresolved"; resolution: Exclude<SymbolResolutionResult, { status: "resolved" }> };

			const outcome = await withLspClient<QueryOutcome>(
				contextFile,
				async (client) => {
					if (
						hasPosition &&
						params.filePath !== undefined &&
						params.line !== undefined &&
						params.character !== undefined
					) {
						const refs = await client.references(
							params.filePath,
							params.line,
							params.character,
							params.includeDeclaration ?? true,
							signal,
						);
						return {
							kind: "references",
							references: Array.isArray(refs) ? refs : [],
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
					if (resolution.status !== "resolved") {
						return { kind: "unresolved", resolution };
					}

					const { target } = resolution;
					const refs = await client.references(
						target.filePath,
						target.line,
						target.character,
						params.includeDeclaration ?? true,
						signal,
					);
					return {
						kind: "references",
						references: Array.isArray(refs) ? refs : [],
						resolvedFilePath: target.filePath,
						resolvedLine: target.line,
						resolvedCharacter: target.character,
						resolvedNote: `Resolved '${symbol}' -> ${target.filePath}:${target.line}:${target.character}`,
					};
				},
				"references",
				{ manager, onUpdate, ...(signal === undefined ? {} : { signal }) },
			);

			if (outcome.kind === "unresolved") {
				const { resolution } = outcome;
				if (resolution.status === "ambiguous") {
					const text =
						`Multiple symbols match '${symbol}'. Specify filePath, Container.symbol, or line/character:\n` +
						formatSymbolCandidates(resolution.matches, lineCache);
					return {
						content: [{ type: "text", text }],
						details: {
							...baseDetails(params),
							references: [],
							totalReferences: 0,
							truncated: false,
							error: text,
							errorKind: "ambiguous",
						} satisfies LspFindReferencesDetails,
					};
				}

				const hint =
					resolution.suggestions.length > 0
						? `\nDid you mean:\n${formatSymbolCandidates(resolution.suggestions, lineCache)}`
						: "";
				const text = `Symbol '${symbol}' not found.${hint}`;
				return {
					content: [{ type: "text", text }],
					details: {
						...baseDetails(params),
						references: [],
						totalReferences: 0,
						truncated: false,
						error: text,
						errorKind: "not_found",
					} satisfies LspFindReferencesDetails,
				};
			}

			const all = outcome.references;
			const total = all.length;
			const truncated = total > DEFAULT_MAX_REFERENCES;
			const limited = truncated ? all.slice(0, DEFAULT_MAX_REFERENCES) : all;

			if (total === 0) {
				const text = outcome.resolvedNote ? `${outcome.resolvedNote}\nNo references found` : "No references found";
				return {
					content: [{ type: "text", text }],
					details: {
						...(symbol !== undefined ? { symbol } : {}),
						filePath: outcome.resolvedFilePath,
						line: outcome.resolvedLine,
						character: outcome.resolvedCharacter,
						references: [],
						totalReferences: 0,
						truncated: false,
					} satisfies LspFindReferencesDetails,
				};
			}

			const lines = limited.map((loc) => formatLocationWithSource(loc, lineCache));
			if (truncated) {
				lines.unshift(`Found ${total} references (showing first ${DEFAULT_MAX_REFERENCES}):`);
			}
			if (outcome.resolvedNote) {
				lines.unshift(outcome.resolvedNote);
			}
			const text = lines.join("\n");
			return {
				content: [{ type: "text", text }],
				details: {
					...(symbol !== undefined ? { symbol } : {}),
					filePath: outcome.resolvedFilePath,
					line: outcome.resolvedLine,
					character: outcome.resolvedCharacter,
					references: all,
					totalReferences: total,
					truncated,
				} satisfies LspFindReferencesDetails,
			};
		} catch (e) {
			const message = handleMissingDependencyError(e);
			if (message) {
				return {
					content: [{ type: "text", text: message }],
					details: {
						...baseDetails(params),
						references: [],
						totalReferences: 0,
						truncated: false,
						error: message,
						errorKind: "missing_dependency",
					} satisfies LspFindReferencesDetails,
				};
			}
			throw e;
		}
	},
});
