import { describe, expect, it } from "vitest";

import { getServerReadiness, isNotReadyError, isStandardNotReadyError } from "../src/lsp/readiness.js";

describe("isStandardNotReadyError", () => {
	it("treats LSP ContentModified (-32801) and RequestCancelled (-32800) as not-ready", () => {
		// given the spec-defined "retry" codes
		// then they are recognized regardless of server
		expect(isStandardNotReadyError({ code: -32801 })).toBe(true);
		expect(isStandardNotReadyError({ code: -32800 })).toBe(true);
	});

	it("does not treat ordinary errors as not-ready", () => {
		expect(isStandardNotReadyError({ code: 1, message: "boom" })).toBe(false);
		expect(isStandardNotReadyError(new Error("nope"))).toBe(false);
		expect(isStandardNotReadyError(undefined)).toBe(false);
	});
});

describe("isNotReadyError", () => {
	it("matches typescript's 'No Project.' loading error via the server matcher", () => {
		// given the bespoke tsserver cold error
		const err = { code: 1, message: "TypeScript Server Error\nNo Project.\n at ThrowNoProject" };
		// then it is not-ready for typescript
		expect(isNotReadyError(err, "typescript")).toBe(true);
		expect(isNotReadyError(err, "vtsls")).toBe(true);
	});

	it("does not apply the typescript matcher to other servers (backwards compatible)", () => {
		const err = { code: 1, message: "No Project." };
		// then an unknown server only honors the standard codes, not tsserver's text
		expect(isNotReadyError(err, "gopls")).toBe(false);
	});

	it("honors standard codes for any server", () => {
		expect(isNotReadyError({ code: -32800 }, "pyrefly")).toBe(true);
		expect(isNotReadyError({ code: -32800 }, "some-unknown-server")).toBe(true);
	});

	it("treats an unrelated typescript error as ready", () => {
		expect(isNotReadyError({ code: 1, message: "Cannot find name 'x'" }, "typescript")).toBe(false);
	});

	it("requires the exact 'No Project.' substring, not a loose lowercase match", () => {
		// the literal tsserver phrase is "No Project." (capitalized, with the
		// period) - a stray lowercase occurrence in a user-facing diagnostic
		// should not trigger retry
		expect(isNotReadyError({ code: 1, message: "no project found in tsconfig" }, "typescript")).toBe(false);
	});
});

describe("getServerReadiness", () => {
	it("only describes servers whose cold behavior needs handling", () => {
		expect(getServerReadiness("typescript")?.requiresOpenFileToInitProject).toBe(true);
		expect(getServerReadiness("vtsls")?.requiresOpenFileToInitProject).toBe(true);
		// ty (blocks) and pyright (soft-empty) need nothing
		expect(getServerReadiness("ty")).toBeUndefined();
		expect(getServerReadiness("pyright")).toBeUndefined();
	});
});
