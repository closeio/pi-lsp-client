import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import type { LspClient } from "../src/lsp/client.js";
import {
	findIdentifierInFile,
	findIdentifierPositionInRange,
	parseSymbolQuery,
	resolveSymbolPosition,
} from "../src/lsp/symbol-resolution.js";
import type { DocumentSymbol, SymbolInfo } from "../src/lsp/types.js";

function makeFakeClient(opts: {
	documentSymbols?: Array<DocumentSymbol | SymbolInfo>;
	workspaceSymbols?: SymbolInfo[];
}): LspClient {
	return {
		documentSymbols: async () => opts.documentSymbols ?? [],
		workspaceSymbols: async () => opts.workspaceSymbols ?? [],
	} as unknown as LspClient;
}

describe("parseSymbolQuery", () => {
	it("#given unqualified and qualified names #when parsing #then extracts baseName and containerName", () => {
		expect(parseSymbolQuery("renderDiffMap")).toEqual({ raw: "renderDiffMap", baseName: "renderDiffMap" });
		expect(parseSymbolQuery("LspManager.getClient")).toEqual({
			raw: "LspManager.getClient",
			containerName: "LspManager",
			baseName: "getClient",
		});
		expect(parseSymbolQuery("LspManager::getClient")).toEqual({
			raw: "LspManager::getClient",
			containerName: "LspManager",
			baseName: "getClient",
		});
		expect(parseSymbolQuery("LspManager/getClient")).toEqual({
			raw: "LspManager/getClient",
			containerName: "LspManager",
			baseName: "getClient",
		});
	});
});

describe("findIdentifierPositionInRange", () => {
	it("#given workspace/symbol range starting at column 0 #when locating identifier #then returns exact identifier column", () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-col-"));
		try {
			const filePath = join(dir, "diff.ts");
			writeFileSync(filePath, "export function renderDiffMap(input: string): string {\n  return input;\n}\n");

			// when
			const pos = findIdentifierPositionInRange(
				filePath,
				{ start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
				"renderDiffMap",
			);

			// then: column 16 is 'r' in renderDiffMap, not column 0 ('e' in export)
			expect(pos).toEqual({ line: 1, character: 16 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("#given a symbol name that is a substring of another identifier #when scanning #then requires word boundaries", () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-word-"));
		try {
			const filePath = join(dir, "sample.ts");
			writeFileSync(filePath, "const myFooBar = 1;\nexport function foo() {}\n");

			// when
			const pos = findIdentifierPositionInRange(
				filePath,
				{ start: { line: 0, character: 0 }, end: { line: 1, character: 24 } },
				"foo",
			);

			// then
			expect(pos).toEqual({ line: 2, character: 16 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findIdentifierInFile", () => {
	it("#given comment and code occurrences #when scanning file #then prefers the code occurrence", () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-usage-"));
		try {
			const filePath = join(dir, "caller.ts");
			writeFileSync(filePath, "// calls renderDiffMap below\nconst out = renderDiffMap(diff);\n");

			// when
			const pos = findIdentifierInFile(filePath, "renderDiffMap");

			// then
			expect(pos).toEqual({ line: 2, character: 12 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("resolveSymbolPosition", () => {
	it("#given filePath with hierarchical DocumentSymbols #when resolving qualified method #then uses selectionRange directly", async () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-doc-"));
		try {
			const filePath = join(dir, "manager.ts");
			writeFileSync(filePath, "class LspManager {\n  getClient() {}\n}\n");
			const client = makeFakeClient({
				documentSymbols: [
					{
						name: "LspManager",
						kind: 5,
						range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
						selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 16 } },
						children: [
							{
								name: "getClient",
								kind: 6,
								range: { start: { line: 1, character: 2 }, end: { line: 1, character: 16 } },
								selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 11 } },
							},
						],
					},
				],
			});

			// when
			const res = await resolveSymbolPosition(client, "LspManager.getClient", { filePath });

			// then
			expect(res.status).toBe("resolved");
			if (res.status !== "resolved") throw new Error("expected resolved");
			expect(res.target).toMatchObject({
				filePath,
				line: 2,
				character: 2,
				name: "getClient",
				containerName: "LspManager",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("#given workspace/symbol with fuzzy and exact matches #when resolving without filePath #then filters to exact match and fixes column", async () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-ws-"));
		try {
			const filePath = join(dir, "diff.ts");
			writeFileSync(filePath, "export function renderDiffMap() {}\nexport function renderDiffMapHeader() {}\n");
			const uri = pathToFileURL(filePath).href;
			const client = makeFakeClient({
				workspaceSymbols: [
					{
						name: "renderDiffMapHeader",
						kind: 12,
						location: { uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 40 } } },
					},
					{
						name: "renderDiffMap",
						kind: 12,
						location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 34 } } },
					},
				],
			});

			// when
			const res = await resolveSymbolPosition(client, "renderDiffMap");

			// then
			expect(res.status).toBe("resolved");
			if (res.status !== "resolved") throw new Error("expected resolved");
			expect(res.target).toMatchObject({
				filePath,
				line: 1,
				character: 16,
				name: "renderDiffMap",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("#given two classes with the same method name #when resolving unqualified name #then returns ambiguous matches", async () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-ambig-"));
		try {
			const filePath = join(dir, "classes.ts");
			writeFileSync(filePath, "class A { stop() {} }\nclass B { stop() {} }\n");
			const uri = pathToFileURL(filePath).href;
			const client = makeFakeClient({
				workspaceSymbols: [
					{
						name: "stop",
						kind: 6,
						containerName: "A",
						location: { uri, range: { start: { line: 0, character: 10 }, end: { line: 0, character: 19 } } },
					},
					{
						name: "stop",
						kind: 6,
						containerName: "B",
						location: { uri, range: { start: { line: 1, character: 10 }, end: { line: 1, character: 19 } } },
					},
				],
			});

			// when
			const res = await resolveSymbolPosition(client, "stop");

			// then
			expect(res.status).toBe("ambiguous");
			if (res.status !== "ambiguous") throw new Error("expected ambiguous");
			expect(res.matches).toHaveLength(2);
			expect(res.matches.map((m) => m.containerName)).toEqual(["A", "B"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("#given no exact symbol match #when workspaceSymbols returns fuzzy hits #then returns not_found with suggestions", async () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-nf-"));
		try {
			const filePath = join(dir, "diff.ts");
			writeFileSync(filePath, "export function renderDiffMap() {}\n");
			const uri = pathToFileURL(filePath).href;
			const client = makeFakeClient({
				workspaceSymbols: [
					{
						name: "renderDiffMap",
						kind: 12,
						location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 34 } } },
					},
				],
			});

			// when
			const res = await resolveSymbolPosition(client, "renderDiff");

			// then
			expect(res.status).toBe("not_found");
			if (res.status !== "not_found") throw new Error("expected not_found");
			expect(res.suggestions.map((s) => s.name)).toEqual(["renderDiffMap"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("#given imported symbol used in filePath #when allowFileUsageFallback is true #then resolves usage position", async () => {
		// given
		const dir = mkdtempSync(join(tmpdir(), "pi-lsp-sym-import-"));
		try {
			const filePath = join(dir, "tool.ts");
			writeFileSync(
				filePath,
				'import { defineTool } from "@earendil-works/pi-coding-agent";\nexport const t = defineTool({});\n',
			);
			const client = makeFakeClient({ documentSymbols: [], workspaceSymbols: [] });

			// when
			const res = await resolveSymbolPosition(client, "defineTool", {
				filePath,
				allowFileUsageFallback: true,
			});

			// then
			expect(res.status).toBe("resolved");
			if (res.status !== "resolved") throw new Error("expected resolved");
			expect(res.target).toMatchObject({
				filePath,
				line: 1,
				character: 9,
				name: "defineTool",
				fromUsage: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
