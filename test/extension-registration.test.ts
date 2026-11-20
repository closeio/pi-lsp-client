import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { lsp_diagnostics } from "../src/lsp/tools/diagnostics.js";
import { lsp_find_references } from "../src/lsp/tools/find-references.js";
import { lsp_goto_definition } from "../src/lsp/tools/goto-definition.js";
import { lsp_prepare_rename, lsp_rename } from "../src/lsp/tools/rename.js";
import { lsp_symbols } from "../src/lsp/tools/symbols.js";

describe("lsp_diagnostics tool definition", () => {
	it("#given diagnostics tool #when inspecting metadata #then exposes expected name and label", () => {
		// given / when / then
		expect(lsp_diagnostics.name).toBe("lsp_diagnostics");
		expect(lsp_diagnostics.label).toBe("LSP Diagnostics");
		expect(lsp_diagnostics.description).toContain("language server");
	});

	it("#given diagnostics parameters #when inspecting schema #then requires filePath only", () => {
		// given
		const objectSchema = Type.Object({});
		const parameters = lsp_diagnostics.parameters;

		// when / then
		expect(parameters.type).toBe(objectSchema.type);
		expect(parameters.required).toEqual(["filePath"]);
		expect(parameters.properties).toHaveProperty("filePath");
		expect(parameters.properties).toHaveProperty("severity");
	});
});

describe("lsp_goto_definition tool definition", () => {
	it("#given goto tool #when inspecting metadata #then matches name and required params", () => {
		// given / when / then
		expect(lsp_goto_definition.name).toBe("lsp_goto_definition");
		expect(lsp_goto_definition.parameters.required).toEqual(["filePath", "line", "character"]);
	});
});

describe("lsp_find_references tool definition", () => {
	it("#given references tool #when inspecting metadata #then matches name and required params", () => {
		// given / when / then
		expect(lsp_find_references.name).toBe("lsp_find_references");
		expect(lsp_find_references.parameters.required).toEqual(["filePath", "line", "character"]);
	});
});

describe("lsp_symbols tool definition", () => {
	it("#given symbols tool #when inspecting metadata #then matches name and scope enum", () => {
		// given / when / then
		expect(lsp_symbols.name).toBe("lsp_symbols");
		expect(lsp_symbols.parameters.required).toContain("filePath");
		expect(lsp_symbols.parameters.required).toContain("scope");
	});
});

describe("lsp_prepare_rename tool definition", () => {
	it("#given prepare rename #when inspecting metadata #then matches name and is parallel-safe", () => {
		// given / when / then
		expect(lsp_prepare_rename.name).toBe("lsp_prepare_rename");
		expect(lsp_prepare_rename.executionMode).toBeUndefined();
		expect(lsp_prepare_rename.parameters.required).toEqual(["filePath", "line", "character"]);
	});
});

describe("lsp_rename tool definition", () => {
	it("#given rename tool #when inspecting metadata #then is sequential and requires newName", () => {
		// given / when / then
		expect(lsp_rename.name).toBe("lsp_rename");
		expect(lsp_rename.executionMode).toBe("sequential");
		expect(lsp_rename.parameters.required).toEqual(["filePath", "line", "character", "newName"]);
	});
});

describe("pi-schema argument validation", () => {
	it("#given diagnostics and symbols schemas #when inspecting enum properties #then expose JSON Schema string enums", () => {
		// given / when
		const severity = lsp_diagnostics.parameters.properties.severity;
		const scope = lsp_symbols.parameters.properties.scope;

		// then
		expect(severity).toMatchObject({
			type: "string",
			enum: ["error", "warning", "information", "hint", "all"],
		});
		expect(scope).toMatchObject({
			type: "string",
			enum: ["document", "workspace"],
		});
	});

	it("#given tool schemas #when validating arguments with pi-ai #then accepts valid calls and rejects invalid enum values", () => {
		// given / when
		const diag = validateToolArguments(lsp_diagnostics, {
			type: "toolCall",
			id: "call-1",
			name: "lsp_diagnostics",
			arguments: { filePath: "src/index.ts", severity: "error" },
		});
		const sym = validateToolArguments(lsp_symbols, {
			type: "toolCall",
			id: "call-2",
			name: "lsp_symbols",
			arguments: { filePath: "src/index.ts", scope: "document" },
		});

		// then
		expect(diag).toEqual({ filePath: "src/index.ts", severity: "error" });
		expect(sym).toEqual({ filePath: "src/index.ts", scope: "document" });
		expect(() =>
			validateToolArguments(lsp_diagnostics, {
				type: "toolCall",
				id: "call-3",
				name: "lsp_diagnostics",
				arguments: { filePath: "src/index.ts", severity: "invalid" },
			}),
		).toThrow();
	});
});

describe("system prompt metadata", () => {
	const allTools = [
		lsp_diagnostics,
		lsp_goto_definition,
		lsp_find_references,
		lsp_symbols,
		lsp_prepare_rename,
		lsp_rename,
	];

	it("#given all registered LSP tools #when inspecting promptSnippet and promptGuidelines #then every tool opts into system prompt advertising and names itself in its guidelines", () => {
		for (const tool of allTools) {
			expect(tool.promptSnippet).toBeTruthy();
			expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
			for (const guideline of tool.promptGuidelines ?? []) {
				expect(guideline).toContain(tool.name);
			}
		}
	});
});
