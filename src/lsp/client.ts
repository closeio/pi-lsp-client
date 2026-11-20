import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LspClientConnection } from "./connection.js";
import { INIT_TIMEOUT_MS, PROJECT_LOAD_GRACE_MS } from "./constants.js";
import { getLanguageId } from "./language-mappings.js";
import { getServerReadiness } from "./readiness.js";
import type {
	Diagnostic,
	DocumentSymbol,
	Location,
	LocationLink,
	PrepareRenameDefaultBehavior,
	PrepareRenameResult,
	Range,
	SymbolInfo,
	WorkspaceEdit,
} from "./types.js";
import { awaitWithSignal } from "./utils.js";

const POST_OPEN_DELAY_MS = 1000;
const POST_DIAGNOSTICS_WAIT_MS = 500;

export class LspClient extends LspClientConnection {
	private readonly openedFiles = new Set<string>();
	private readonly documentVersions = new Map<string, number>();
	private readonly lastSyncedText = new Map<string, string>();
	private readonly diagnosticPullErrors: Error[] = [];
	private projectReady = false;
	private projectReadyPromise: Promise<void> | null = null;

	getDiagnosticPullErrors(): readonly Error[] {
		return this.diagnosticPullErrors;
	}

	async openFile(filePath: string, options?: { skipDelay?: boolean }): Promise<void> {
		const absPath = resolve(filePath);
		const uri = pathToFileURL(absPath).href;
		const text = readFileSync(absPath, "utf-8");

		if (!this.openedFiles.has(absPath)) {
			const ext = extname(absPath);
			const languageId = getLanguageId(ext);
			const version = 1;

			await this.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId,
					version,
					text,
				},
			});

			this.openedFiles.add(absPath);
			this.documentVersions.set(uri, version);
			this.lastSyncedText.set(uri, text);
			if (!options?.skipDelay) {
				await new Promise((r) => setTimeout(r, POST_OPEN_DELAY_MS));
				if (getServerReadiness(this.server.id)?.waitForProjectProgress) {
					await this.waitForActiveProgress();
				}
			}
			return;
		}

		const prevText = this.lastSyncedText.get(uri);
		if (prevText === text) {
			return;
		}

		const nextVersion = (this.documentVersions.get(uri) ?? 1) + 1;
		this.documentVersions.set(uri, nextVersion);
		this.lastSyncedText.set(uri, text);

		await this.sendNotification("textDocument/didChange", {
			textDocument: { uri, version: nextVersion },
			contentChanges: [{ text }],
		});

		await this.sendNotification("textDocument/didSave", {
			textDocument: { uri },
			text,
		});
	}

	/**
	 * Open a seed file and wait for the server's initial background project load
	 * (`$/progress` `begin` -> `end`, or initial `publishDiagnostics` for
	 * inferred projects without a config file). Shared across concurrent callers
	 * so only one project load runs and callers can still abort independently.
	 */
	async waitForProjectReady(
		seedFilePath: string,
		signal?: AbortSignal,
		options?: { background?: boolean },
	): Promise<void> {
		signal?.throwIfAborted();
		const loadTimeoutMs = this.server.initTimeoutMs ?? INIT_TIMEOUT_MS;
		const isBackground = options?.background === true;
		if (this.projectReady) {
			await this.waitForActiveProgress(loadTimeoutMs, signal, options);
			return;
		}

		if (!this.projectReadyPromise) {
			const absPath = resolve(seedFilePath);
			const uri = pathToFileURL(absPath).href;
			this.projectReadyPromise = (async () => {
				await this.openFile(absPath, { skipDelay: true });
				await this.waitForProgressCondition(
					() => this.hasSeenProgress || this.diagnosticsReceivedUris.has(uri) || !this.isAlive(),
					PROJECT_LOAD_GRACE_MS,
					undefined,
					{ background: isBackground },
				);
				if (this.activeProgressTokens.size > 0 && this.isAlive()) {
					await this.waitForActiveProgress(loadTimeoutMs, undefined, { background: isBackground });
				}
				this.projectReady = true;
			})().catch((err) => {
				this.projectReadyPromise = null;
				throw err;
			});
		}

		if (!isBackground) {
			this.refProgressWait();
		}
		try {
			await awaitWithSignal(this.projectReadyPromise, signal);
		} finally {
			if (!isBackground) {
				this.unrefProgressWait();
			}
		}
	}

	async definition(
		filePath: string,
		line: number,
		character: number,
	): Promise<Location | LocationLink | Array<Location | LocationLink> | null> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Location | LocationLink | Array<Location | LocationLink> | null>(
			"textDocument/definition",
			{
				textDocument: { uri: pathToFileURL(absPath).href },
				position: { line: line - 1, character },
			},
		);
	}

	async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[]> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Location[]>("textDocument/references", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
			context: { includeDeclaration },
		});
	}

	async documentSymbols(filePath: string): Promise<Array<DocumentSymbol | SymbolInfo>> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<Array<DocumentSymbol | SymbolInfo>>("textDocument/documentSymbol", {
			textDocument: { uri: pathToFileURL(absPath).href },
		});
	}

	async workspaceSymbols(query: string): Promise<SymbolInfo[]> {
		return this.sendRequest<SymbolInfo[]>("workspace/symbol", { query });
	}

	private isUnsupportedDiagnosticPullError(error: unknown): boolean {
		if (!(error instanceof Error)) return false;
		const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
		if (code === -32601) return true;
		return /unsupported|not supported|method not found|unknown request/i.test(error.message);
	}

	async diagnostics(filePath: string): Promise<{ items: Diagnostic[] }> {
		const absPath = resolve(filePath);
		const uri = pathToFileURL(absPath).href;
		await this.openFile(absPath);
		await new Promise((r) => setTimeout(r, POST_DIAGNOSTICS_WAIT_MS));

		try {
			const result = await this.sendRequest<{ items?: Diagnostic[] }>("textDocument/diagnostic", {
				textDocument: { uri },
			});
			if (result.items) {
				return { items: result.items };
			}
		} catch (error) {
			if (!this.isUnsupportedDiagnosticPullError(error)) {
				this.diagnosticPullErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}

		return { items: this.getStoredDiagnostics(uri) };
	}

	async prepareRename(
		filePath: string,
		line: number,
		character: number,
	): Promise<PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null>(
			"textDocument/prepareRename",
			{
				textDocument: { uri: pathToFileURL(absPath).href },
				position: { line: line - 1, character },
			},
		);
	}

	async rename(filePath: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
		const absPath = resolve(filePath);
		await this.openFile(absPath);
		return this.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
			textDocument: { uri: pathToFileURL(absPath).href },
			position: { line: line - 1, character },
			newName,
		});
	}
}
