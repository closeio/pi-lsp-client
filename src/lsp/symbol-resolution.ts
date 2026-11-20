import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { LspClient } from "./client.js";
import { formatLocationWithSource, type SourceLineCache, uriToPath } from "./formatters.js";
import { inferPrimarySeedFile } from "./infer-extension.js";
import { findServerForExtension } from "./server-resolution.js";
import type { DocumentSymbol, Location, Range, SymbolInfo } from "./types.js";

const MAX_RANGE_SCAN_LINES = 5;
const MAX_FUZZY_SUGGESTIONS = 10;

export interface ParsedSymbolQuery {
	raw: string;
	baseName: string;
	containerName?: string;
}

export interface ResolvedSymbolTarget {
	filePath: string;
	/** 1-based line number matching LspClient methods. */
	line: number;
	/** 0-based character column matching LspClient methods. */
	character: number;
	name: string;
	containerName?: string;
	location: Location;
	/** True when resolved from a usage token inside `filePath` rather than a symbol declaration. */
	fromUsage?: boolean;
}

export type SymbolResolutionResult =
	| { status: "resolved"; target: ResolvedSymbolTarget }
	| { status: "ambiguous"; matches: ResolvedSymbolTarget[] }
	| { status: "not_found"; suggestions: ResolvedSymbolTarget[] };

export function parseSymbolQuery(query: string): ParsedSymbolQuery {
	const raw = query.trim();
	const sepMatch = /^(.*?)(?:\.|::|\/)([^.:/]+)$/.exec(raw);
	if (sepMatch?.[1] && sepMatch[2]) {
		return {
			raw,
			containerName: sepMatch[1],
			baseName: sepMatch[2],
		};
	}
	return { raw, baseName: raw };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readCachedLines(filePath: string, cache: SourceLineCache): string[] | null {
	let lines = cache.get(filePath);
	if (lines === undefined) {
		try {
			lines = readFileSync(filePath, "utf-8").split(/\r?\n/);
		} catch {
			lines = null;
		}
		cache.set(filePath, lines);
	}
	return lines;
}

function buildIdentifierRegex(identifier: string): RegExp {
	return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(identifier)}(?![A-Za-z0-9_$])`);
}

/**
 * Locate the exact identifier column within a symbol declaration range.
 * `workspace/symbol` often reports `range.start` at column 0 (e.g. `export` or `def`)
 * instead of the identifier token itself.
 */
export function findIdentifierPositionInRange(
	filePath: string,
	range: Range,
	identifier: string,
	cache: SourceLineCache = new Map(),
): { line: number; character: number } {
	const lines = readCachedLines(filePath, cache);
	if (lines && identifier.length > 0) {
		const pattern = buildIdentifierRegex(identifier);
		const startLine = Math.max(0, range.start.line);
		const endLine = Math.min(
			lines.length - 1,
			Math.max(startLine, Math.min(range.end.line, startLine + MAX_RANGE_SCAN_LINES)),
		);

		for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
			const lineText = lines[lineIdx];
			if (lineText === undefined) continue;
			const offset = lineIdx === startLine ? Math.max(0, range.start.character) : 0;
			const match = pattern.exec(lineText.slice(offset));
			if (match) {
				return {
					line: lineIdx + 1,
					character: offset + match.index,
				};
			}
		}
	}

	return {
		line: range.start.line + 1,
		character: range.start.character,
	};
}

function isCommentLine(trimmed: string): boolean {
	return (
		trimmed.startsWith("//") ||
		trimmed.startsWith("#") ||
		trimmed.startsWith("*") ||
		trimmed.startsWith("/*") ||
		trimmed.startsWith("--")
	);
}

/**
 * Find an identifier occurrence in a source file, preferring non-comment lines.
 * Used as a fallback for `lsp_goto_definition` when `symbol` is an imported or
 * local usage inside `filePath` rather than a declared symbol.
 */
export function findIdentifierInFile(
	filePath: string,
	identifier: string,
	cache: SourceLineCache = new Map(),
): { line: number; character: number } | null {
	if (identifier.length === 0) return null;
	const lines = readCachedLines(filePath, cache);
	if (!lines) return null;

	const pattern = buildIdentifierRegex(identifier);
	let commentFallback: { line: number; character: number } | null = null;

	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i];
		if (lineText === undefined) continue;
		const match = pattern.exec(lineText);
		if (!match) continue;
		const pos = { line: i + 1, character: match.index };
		if (!isCommentLine(lineText.trim())) {
			return pos;
		}
		if (!commentFallback) {
			commentFallback = pos;
		}
	}

	return commentFallback;
}

function isDocumentSymbol(symbol: DocumentSymbol | SymbolInfo): symbol is DocumentSymbol {
	return "selectionRange" in symbol;
}

function matchesSymbolQuery(name: string, containerName: string | undefined, parsed: ParsedSymbolQuery): boolean {
	if (parsed.containerName) {
		const qualifiesContainer =
			containerName === parsed.containerName ||
			containerName?.endsWith(`.${parsed.containerName}`) ||
			containerName?.endsWith(`::${parsed.containerName}`);
		if (name === parsed.baseName && qualifiesContainer) {
			return true;
		}
		return (
			name === `${parsed.containerName}.${parsed.baseName}` || name === `${parsed.containerName}::${parsed.baseName}`
		);
	}

	return name === parsed.baseName || name.endsWith(`.${parsed.baseName}`) || name.endsWith(`::${parsed.baseName}`);
}

function flattenDocumentSymbols(
	symbols: DocumentSymbol[],
	filePath: string,
	uri: string,
	parent?: string,
): ResolvedSymbolTarget[] {
	const out: ResolvedSymbolTarget[] = [];
	for (const sym of symbols) {
		const target: ResolvedSymbolTarget = {
			filePath,
			line: sym.selectionRange.start.line + 1,
			character: sym.selectionRange.start.character,
			name: sym.name,
			...(parent ? { containerName: parent } : {}),
			location: { uri, range: sym.selectionRange },
		};
		out.push(target);
		if (sym.children && sym.children.length > 0) {
			out.push(...flattenDocumentSymbols(sym.children, filePath, uri, sym.name));
		}
	}
	return out;
}

function symbolInfoToTarget(
	sym: SymbolInfo,
	identifierForPosition: string,
	cache: SourceLineCache,
): ResolvedSymbolTarget {
	const filePath = uriToPath(sym.location.uri);
	const pos = findIdentifierPositionInRange(filePath, sym.location.range, identifierForPosition, cache);
	return {
		filePath,
		line: pos.line,
		character: pos.character,
		name: sym.name,
		...(sym.containerName ? { containerName: sym.containerName } : {}),
		location: {
			uri: sym.location.uri,
			range: {
				start: { line: pos.line - 1, character: pos.character },
				end: { line: pos.line - 1, character: pos.character + identifierForPosition.length },
			},
		},
	};
}

function dedupeTargets(targets: ResolvedSymbolTarget[]): ResolvedSymbolTarget[] {
	const seen = new Set<string>();
	const unique: ResolvedSymbolTarget[] = [];
	for (const target of targets) {
		const key = `${target.filePath}:${target.line}:${target.character}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(target);
	}
	return unique;
}

export function resolveWorkspaceContextFile(cwd: string): string | null {
	const primary = inferPrimarySeedFile(cwd);
	if (!primary) return null;
	const lookup = findServerForExtension(primary.extension);
	if (lookup.status !== "found") return null;
	return primary.filePath;
}

export interface ResolveSymbolOptions {
	filePath?: string;
	signal?: AbortSignal;
	/** If true and `filePath` is set, fall back to matching a usage token inside `filePath`. */
	allowFileUsageFallback?: boolean;
	lineCache?: SourceLineCache;
}

export async function resolveSymbolPosition(
	client: LspClient,
	symbolQuery: string,
	options: ResolveSymbolOptions = {},
): Promise<SymbolResolutionResult> {
	const parsed = parseSymbolQuery(symbolQuery);
	if (!parsed.baseName) {
		return { status: "not_found", suggestions: [] };
	}

	const cache = options.lineCache ?? new Map();
	const absFilePath = options.filePath ? resolve(options.filePath) : undefined;
	const docSuggestions: ResolvedSymbolTarget[] = [];

	if (absFilePath) {
		const docUri = pathToFileURL(absFilePath).href;
		const docSymbols = await client.documentSymbols(absFilePath, options.signal);
		const flattened =
			docSymbols.length > 0 && isDocumentSymbol(docSymbols[0] as DocumentSymbol | SymbolInfo)
				? flattenDocumentSymbols(docSymbols as DocumentSymbol[], absFilePath, docUri)
				: (docSymbols as SymbolInfo[]).map((sym) => symbolInfoToTarget(sym, sym.name, cache));

		const exactDoc = dedupeTargets(
			flattened.filter((target) => matchesSymbolQuery(target.name, target.containerName, parsed)),
		);
		if (exactDoc.length === 1 && exactDoc[0]) {
			return { status: "resolved", target: exactDoc[0] };
		}
		if (exactDoc.length > 1) {
			return { status: "ambiguous", matches: exactDoc };
		}

		const queryLower = parsed.baseName.toLowerCase();
		for (const target of flattened) {
			if (target.name.toLowerCase().includes(queryLower)) {
				docSuggestions.push(target);
			}
		}
	}

	const workspaceSymbols = await client.workspaceSymbols(parsed.baseName);
	const exactWorkspace = dedupeTargets(
		workspaceSymbols
			.filter((sym) => matchesSymbolQuery(sym.name, sym.containerName, parsed))
			.map((sym) => symbolInfoToTarget(sym, parsed.baseName, cache)),
	);

	if (exactWorkspace.length === 1 && exactWorkspace[0]) {
		return { status: "resolved", target: exactWorkspace[0] };
	}
	if (exactWorkspace.length > 1) {
		if (absFilePath) {
			const inFile = exactWorkspace.filter((t) => resolve(t.filePath) === absFilePath);
			if (inFile.length === 1 && inFile[0]) {
				return { status: "resolved", target: inFile[0] };
			}
			if (inFile.length > 1) {
				return { status: "ambiguous", matches: inFile };
			}
		}
		return { status: "ambiguous", matches: exactWorkspace };
	}

	if (absFilePath && options.allowFileUsageFallback) {
		const usage = findIdentifierInFile(absFilePath, parsed.baseName, cache);
		if (usage) {
			const uri = pathToFileURL(absFilePath).href;
			return {
				status: "resolved",
				target: {
					filePath: absFilePath,
					line: usage.line,
					character: usage.character,
					name: parsed.baseName,
					location: {
						uri,
						range: {
							start: { line: usage.line - 1, character: usage.character },
							end: { line: usage.line - 1, character: usage.character + parsed.baseName.length },
						},
					},
					fromUsage: true,
				},
			};
		}
	}

	const workspaceSuggestions = workspaceSymbols
		.slice(0, MAX_FUZZY_SUGGESTIONS)
		.map((sym) => symbolInfoToTarget(sym, sym.name, cache));
	const suggestions = dedupeTargets([...docSuggestions, ...workspaceSuggestions]).slice(0, MAX_FUZZY_SUGGESTIONS);
	return { status: "not_found", suggestions };
}

export function formatSymbolCandidates(candidates: readonly ResolvedSymbolTarget[], cache?: SourceLineCache): string {
	const lineCache = cache ?? new Map();
	return candidates
		.map((candidate) => {
			const container = candidate.containerName ? ` (in ${candidate.containerName})` : "";
			const loc = formatLocationWithSource(candidate.location, lineCache);
			return `  ${candidate.name}${container} - ${loc}`;
		})
		.join("\n");
}
