import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

import { LspClient } from "../src/lsp/client.js";
import type { Diagnostic } from "../src/lsp/types.js";

import { makeServer } from "./helpers/fake-lsp-client.js";

const diagnostic: Diagnostic = {
	range: {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 1 },
	},
	message: "stored diagnostic",
};

class DiagnosticsHarness extends LspClient {
	constructor(
		root: string,
		private readonly pullError: Error,
		storedDiagnostics: Diagnostic[],
	) {
		super(root, makeServer("typescript"));
		this.diagnosticsStore.set(pathToFileURL(join(root, "sample.ts")).href, storedDiagnostics);
	}

	override async openFile(_filePath: string): Promise<void> {}

	protected override sendRequest<T>(method: string): Promise<T>;
	protected override sendRequest<T>(method: string, params: unknown): Promise<T>;
	protected override async sendRequest<T>(_method: string, _params?: unknown): Promise<T> {
		throw this.pullError;
	}
}

describe("LspClient diagnostics", () => {
	it("#given unsupported pull diagnostics #when diagnostics requested #then falls back without recording an error", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-client-"));
		try {
			const filePath = join(root, "sample.ts");
			writeFileSync(filePath, "const value = 1;\n");
			const client = new DiagnosticsHarness(root, new Error("method not found"), [diagnostic]);

			// when
			const result = await client.diagnostics(filePath);

			// then
			expect(result.items).toEqual([diagnostic]);
			expect(client.getDiagnosticPullErrors()).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#given failed pull diagnostics #when diagnostics requested #then records the error before fallback", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-client-"));
		try {
			const filePath = join(root, "sample.ts");
			writeFileSync(filePath, "const value = 1;\n");
			const pullError = new Error("transport disconnected");
			const client = new DiagnosticsHarness(root, pullError, [diagnostic]);

			// when
			const result = await client.diagnostics(filePath);

			// then
			expect(result.items).toEqual([diagnostic]);
			expect(client.getDiagnosticPullErrors()).toEqual([pullError]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

class ProgressHarness extends LspClient {
	readonly serverConnection: MessageConnection;
	private readonly clientToServer = new PassThrough();
	private readonly serverToClient = new PassThrough();
	private alive = true;

	constructor(root: string) {
		super(root, makeServer("typescript", [".ts"]));
		const clientConn = createMessageConnection(
			new StreamMessageReader(this.serverToClient),
			new StreamMessageWriter(this.clientToServer),
		);
		this.connection = clientConn;
		this.attachConnectionHandlers(clientConn);
		clientConn.listen();

		this.serverConnection = createMessageConnection(
			new StreamMessageReader(this.clientToServer),
			new StreamMessageWriter(this.serverToClient),
		);
		this.serverConnection.onNotification("textDocument/didOpen", () => {});
		this.serverConnection.listen();
	}

	override isAlive(): boolean {
		return this.alive;
	}

	disposeHarness(): void {
		this.alive = false;
		this.connection?.dispose();
		this.serverConnection.dispose();
		this.clientToServer.destroy();
		this.serverToClient.destroy();
	}
}

describe("LspClient waitForProjectReady", () => {
	it("#given a server emitting $/progress after didOpen #when waitForProjectReady runs #then waits until progress end", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-progress-"));
		const harness = new ProgressHarness(root);
		try {
			const filePath = join(root, "app.ts");
			writeFileSync(filePath, "export const x = 1;\n");

			// when
			let resolved = false;
			const ready = harness.waitForProjectReady(filePath).then(() => {
				resolved = true;
			});

			await harness.serverConnection.sendRequest("window/workDoneProgress/create", { token: "ts-init" });
			await harness.serverConnection.sendNotification("$/progress", {
				token: "ts-init",
				value: { kind: "begin", title: "Initializing JS/TS language features…" },
			});
			await new Promise((r) => setTimeout(r, 30));

			// then: still waiting while progress is active
			expect(resolved).toBe(false);

			// when: server ends progress
			await harness.serverConnection.sendNotification("$/progress", {
				token: "ts-init",
				value: { kind: "end" },
			});
			await ready;

			expect(resolved).toBe(true);
		} finally {
			harness.disposeHarness();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#given two concurrent waitForProjectReady callers #when one aborts #then only the aborted caller rejects and the other completes", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-progress-abort-"));
		const harness = new ProgressHarness(root);
		try {
			const filePath = join(root, "app.ts");
			writeFileSync(filePath, "export const x = 1;\n");
			const controller = new AbortController();

			// when
			const first = harness.waitForProjectReady(filePath, controller.signal);
			const second = harness.waitForProjectReady(filePath);

			await harness.serverConnection.sendRequest("window/workDoneProgress/create", { token: "ts-init" });
			await harness.serverConnection.sendNotification("$/progress", {
				token: "ts-init",
				value: { kind: "begin", title: "Initializing JS/TS language features…" },
			});

			controller.abort();
			await expect(first).rejects.toThrow(/Aborted/);

			await harness.serverConnection.sendNotification("$/progress", {
				token: "ts-init",
				value: { kind: "end" },
			});

			// then
			await expect(second).resolves.toBeUndefined();
		} finally {
			harness.disposeHarness();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#given an inferred project with no $/progress #when publishDiagnostics arrives #then waitForProjectReady resolves immediately", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-progress-diag-"));
		const harness = new ProgressHarness(root);
		try {
			const filePath = join(root, "app.ts");
			writeFileSync(filePath, "export const x = 1;\n");

			// when
			const ready = harness.waitForProjectReady(filePath);
			await harness.serverConnection.sendNotification("textDocument/publishDiagnostics", {
				uri: pathToFileURL(filePath).href,
				diagnostics: [],
			});

			// then
			await expect(ready).resolves.toBeUndefined();
		} finally {
			harness.disposeHarness();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#given a token created via workDoneProgress/create that never begins #when publishDiagnostics arrives #then waitForProjectReady does not stall", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-progress-create-only-"));
		const harness = new ProgressHarness(root);
		try {
			const filePath = join(root, "app.ts");
			writeFileSync(filePath, "export const x = 1;\n");

			// when: server creates a token without sending $/progress begin
			await harness.serverConnection.sendRequest("window/workDoneProgress/create", { token: "unused-token" });
			const ready = harness.waitForProjectReady(filePath);
			await harness.serverConnection.sendNotification("textDocument/publishDiagnostics", {
				uri: pathToFileURL(filePath).href,
				diagnostics: [],
			});

			// then: resolves immediately without waiting for unused-token to end
			await expect(ready).resolves.toBeUndefined();
		} finally {
			harness.disposeHarness();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#given a progress token that begins and never ends #when waitForActiveProgress times out #then stuck token is evicted so later calls do not stall", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-progress-stuck-"));
		const harness = new ProgressHarness(root);
		try {
			await harness.serverConnection.sendNotification("$/progress", {
				token: "stuck-token",
				value: { kind: "begin", title: "Never finishes" },
			});
			await new Promise((r) => setTimeout(r, 20));

			// when: first wait times out and evicts the stuck token
			await harness.waitForActiveProgress(40);
			const t0 = Date.now();
			await harness.waitForActiveProgress(5_000);

			// then: second wait returns immediately instead of stalling again
			expect(Date.now() - t0).toBeLessThan(200);
		} finally {
			harness.disposeHarness();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("#given a path containing parentheses #when server sends percent-encoded publishDiagnostics URI #then waitForProjectReady resolves immediately and diagnostics are retrievable", async () => {
		// given
		const root = mkdtempSync(join(tmpdir(), "pi-lsp-parens-"));
		const harness = new ProgressHarness(root);
		try {
			const dir = join(root, "app", "(marketing)", "[slug]");
			mkdirSync(dir, { recursive: true });
			const filePath = join(dir, "page.ts");
			writeFileSync(filePath, "const x: number = 'oops';\n");
			// vscode-uri / typescript-language-server percent-encodes '(' and ')' where Node pathToFileURL does not
			const encodedUri = pathToFileURL(filePath).href.replace(/\(/g, "%28").replace(/\)/g, "%29");

			// when
			const t0 = Date.now();
			const ready = harness.waitForProjectReady(filePath);
			await harness.serverConnection.sendNotification("textDocument/publishDiagnostics", {
				uri: encodedUri,
				diagnostics: [diagnostic],
			});
			await ready;

			// then: did not stall for PROJECT_LOAD_GRACE_MS and lookup by Node's pathToFileURL finds the diagnostic
			expect(Date.now() - t0).toBeLessThan(1_000);
			expect(harness.getStoredDiagnostics(pathToFileURL(filePath).href)).toEqual([diagnostic]);
		} finally {
			harness.disposeHarness();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
