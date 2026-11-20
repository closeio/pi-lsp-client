import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_FALLBACK_DEFINITION_LINES, DEFAULT_MAX_DEFINITION_LINES } from "./constants.js";

import { SEVERITY_MAP, SYMBOL_KIND_MAP } from "./language-mappings.js";
import type {
	Diagnostic,
	DocumentSymbol,
	Location,
	LocationLink,
	PrepareRenameDefaultBehavior,
	PrepareRenameResult,
	Range,
	SeverityFilter,
	SymbolInfo,
} from "./types.js";
import type { ApplyResult } from "./workspace-edit.js";

const MAX_SOURCE_LINE_CHARS = 200;

export type SourceLineCache = Map<string, string[] | null>;
export function uriToPath(uri: string): string {
	return fileURLToPath(uri);
}

export function formatLocation(loc: Location | LocationLink): string {
	if ("targetUri" in loc) {
		const uri = uriToPath(loc.targetUri);
		const line = loc.targetRange.start.line + 1;
		const char = loc.targetRange.start.character;
		return `${uri}:${line}:${char}`;
	}

	const uri = uriToPath(loc.uri);
	const line = loc.range.start.line + 1;
	const char = loc.range.start.character;
	return `${uri}:${line}:${char}`;
}

function readCachedFileLines(filePath: string, cache?: SourceLineCache): string[] | null {
	let lines: string[] | null | undefined = cache?.get(filePath);
	if (lines === undefined) {
		try {
			lines = readFileSync(filePath, "utf-8").split(/\r\n|[\n\r\u2028\u2029]/);
		} catch {
			lines = null;
		}
		cache?.set(filePath, lines);
	}
	return lines;
}

function capLineLength(line: string): string {
	if (line.length > MAX_SOURCE_LINE_CHARS) {
		return `${line.slice(0, MAX_SOURCE_LINE_CHARS - 1)}…`;
	}
	return line;
}

export function readSourceLine(filePath: string, zeroBasedLine: number, cache?: SourceLineCache): string | null {
	if (zeroBasedLine < 0) return null;
	const lines = readCachedFileLines(filePath, cache);
	if (!lines || zeroBasedLine >= lines.length) return null;
	const trimmed = lines[zeroBasedLine]?.trim() ?? "";
	if (trimmed.length === 0) return null;
	return capLineLength(trimmed);
}

export function formatLocationWithSource(loc: Location | LocationLink, cache?: SourceLineCache): string {
	const base = formatLocation(loc);
	const filePath = uriToPath("targetUri" in loc ? loc.targetUri : loc.uri);
	const zeroBasedLine = "targetRange" in loc ? loc.targetRange.start.line : loc.range.start.line;
	const sourceLine = readSourceLine(filePath, zeroBasedLine, cache);
	return sourceLine ? `${base}  ${sourceLine}` : base;
}

/**
 * Find the innermost hierarchical `DocumentSymbol.range` covering `zeroBasedLine`,
 * preferring a symbol whose `selectionRange` starts on that exact line.
 */
export function findEnclosingSymbolRange(
	symbols: readonly (DocumentSymbol | SymbolInfo)[],
	zeroBasedLine: number,
): Range | null {
	let bestExact: Range | null = null;
	let bestExactSpan = Number.POSITIVE_INFINITY;
	let bestContaining: Range | null = null;
	let bestContainingSpan = Number.POSITIVE_INFINITY;

	const visit = (items: readonly (DocumentSymbol | SymbolInfo)[]): void => {
		for (const item of items) {
			if (!("selectionRange" in item)) continue;
			const { range, selectionRange } = item;
			if (range.start.line <= zeroBasedLine && zeroBasedLine <= range.end.line) {
				const span = range.end.line - range.start.line;
				if (selectionRange.start.line === zeroBasedLine && span <= bestExactSpan) {
					bestExact = range;
					bestExactSpan = span;
				} else if (span <= bestContainingSpan) {
					bestContaining = range;
					bestContainingSpan = span;
				}
				if (item.children && item.children.length > 0) {
					visit(item.children);
				}
			}
		}
	};

	visit(symbols);
	return bestExact ?? bestContaining;
}

export function formatDefinitionWithBody(
	loc: Location | LocationLink,
	bodyRange: Range | null,
	cache?: SourceLineCache,
	maxLines = DEFAULT_MAX_DEFINITION_LINES,
): string {
	const base = formatLocation(loc);
	const filePath = uriToPath("targetUri" in loc ? loc.targetUri : loc.uri);
	const locRange = "targetRange" in loc ? loc.targetRange : loc.range;
	const lines = readCachedFileLines(filePath, cache);
	if (!lines || locRange.start.line < 0 || locRange.start.line >= lines.length) {
		return base;
	}

	const startLine = bodyRange ? Math.max(0, bodyRange.start.line) : locRange.start.line;
	const rawEndLine = bodyRange
		? Math.min(lines.length - 1, Math.max(startLine, bodyRange.end.line))
		: Math.min(lines.length - 1, startLine + DEFAULT_FALLBACK_DEFINITION_LINES - 1);

	// Single-line declarations stay compact on one line
	if (startLine === rawEndLine) {
		const trimmed = lines[startLine]?.trim() ?? "";
		return trimmed.length > 0 ? `${base}  ${capLineLength(trimmed)}` : base;
	}

	const totalLines = rawEndLine - startLine + 1;
	const cappedEndLine = Math.min(rawEndLine, startLine + maxLines - 1);
	const lineNumWidth = String(cappedEndLine + 1).length;
	const out: string[] = [base];
	for (let i = startLine; i <= cappedEndLine; i++) {
		const lineNo = String(i + 1).padStart(lineNumWidth, " ");
		out.push(`  ${lineNo} | ${capLineLength(lines[i] ?? "")}`);
	}
	if (cappedEndLine < rawEndLine) {
		const remaining = totalLines - (cappedEndLine - startLine + 1);
		out.push(`  ... (${remaining} more lines; read from line ${cappedEndLine + 2})`);
	}
	return out.join("\n");
}

export function formatSymbolKind(kind: number): string {
	return SYMBOL_KIND_MAP[kind] ?? `Unknown(${kind})`;
}

export function formatSeverity(severity: number | undefined): string {
	if (!severity) return "unknown";
	return SEVERITY_MAP[severity] ?? `unknown(${severity})`;
}

export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string {
	const prefix = "  ".repeat(indent);
	const kind = formatSymbolKind(symbol.kind);
	const line = symbol.range.start.line + 1;
	let result = `${prefix}${symbol.name} (${kind}) - line ${line}`;

	if (symbol.children && symbol.children.length > 0) {
		for (const child of symbol.children) {
			result += `\n${formatDocumentSymbol(child, indent + 1)}`;
		}
	}

	return result;
}

export function formatSymbolInfo(symbol: SymbolInfo): string {
	const kind = formatSymbolKind(symbol.kind);
	const loc = formatLocation(symbol.location);
	const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
	return `${symbol.name} (${kind})${container} - ${loc}`;
}

export function formatDiagnostic(diag: Diagnostic): string {
	const severity = formatSeverity(diag.severity);
	const line = diag.range.start.line + 1;
	const char = diag.range.start.character;
	const source = diag.source ? `[${diag.source}]` : "";
	const code = diag.code ? ` (${diag.code})` : "";
	return `${severity}${source}${code} at ${line}:${char}: ${diag.message}`;
}

export function filterDiagnosticsBySeverity(diagnostics: Diagnostic[], severityFilter?: SeverityFilter): Diagnostic[] {
	if (!severityFilter || severityFilter === "all") {
		return diagnostics;
	}

	const severityMap: Record<string, number> = {
		error: 1,
		warning: 2,
		information: 3,
		hint: 4,
	};

	const targetSeverity = severityMap[severityFilter];
	if (targetSeverity === undefined) return diagnostics;
	return diagnostics.filter((d) => d.severity === targetSeverity);
}

export function formatPrepareRenameResult(
	result: PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null,
): string {
	if (!result) return "Cannot rename at this position";

	if ("defaultBehavior" in result) {
		return result.defaultBehavior ? "Rename supported (using default behavior)" : "Cannot rename at this position";
	}

	if ("range" in result && result.range) {
		const startLine = result.range.start.line + 1;
		const startChar = result.range.start.character;
		const endLine = result.range.end.line + 1;
		const endChar = result.range.end.character;
		const placeholder = result.placeholder ? ` (current: "${result.placeholder}")` : "";
		return `Rename available at ${startLine}:${startChar}-${endLine}:${endChar}${placeholder}`;
	}

	if ("start" in result && "end" in result) {
		const startLine = result.start.line + 1;
		const startChar = result.start.character;
		const endLine = result.end.line + 1;
		const endChar = result.end.character;
		return `Rename available at ${startLine}:${startChar}-${endLine}:${endChar}`;
	}

	return "Cannot rename at this position";
}

export function formatApplyResult(result: ApplyResult): string {
	const lines: string[] = [];

	if (result.success) {
		lines.push(`Applied ${result.totalEdits} edit(s) to ${result.filesModified.length} file(s):`);
		for (const file of result.filesModified) {
			lines.push(`  - ${file}`);
		}
	} else {
		lines.push("Failed to apply some changes:");
		for (const err of result.errors) {
			lines.push(`  Error: ${err}`);
		}
		if (result.filesModified.length > 0) {
			lines.push(`Successfully modified: ${result.filesModified.join(", ")}`);
		}
	}

	return lines.join("\n");
}
