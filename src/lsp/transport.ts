import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

import { INIT_TIMEOUT_MS, REQUEST_TIMEOUT_MS, STOP_HARD_KILL_TIMEOUT_MS, STOP_SIGKILL_GRACE_MS } from "./constants.js";
import { LspConnectionClosedError, LspProcessExitedError, LspRequestTimeoutError } from "./errors.js";
import { type SpawnedProcess, spawnProcess } from "./process.js";
import { getAdditionalPathBases } from "./server-installation.js";
import type { Diagnostic, ResolvedServer } from "./types.js";

export function normalizeUriKey(uri: string): string {
	if (uri.startsWith("file://")) {
		try {
			return resolve(fileURLToPath(uri));
		} catch {
			return uri;
		}
	}
	return uri;
}
type ProgressToken = string | number;

interface ProgressNotification {
	token?: ProgressToken;
	value?: {
		kind?: string;
		title?: string;
		message?: string;
		percentage?: number;
	};
}
export class LspClientTransport {
	protected proc: SpawnedProcess | null = null;
	protected connection: MessageConnection | null = null;
	protected readonly stderrBuffer: string[] = [];
	protected processExited = false;
	protected readonly diagnosticsStore = new Map<string, Diagnostic[]>();
	protected readonly activeProgressTokens = new Set<ProgressToken>();
	protected readonly diagnosticsReceivedUris = new Set<string>();
	protected hasSeenProgress = false;
	private readonly progressListeners = new Set<() => void>();
	private readonly backgroundWaitTimers = new Set<NodeJS.Timeout>();
	private foregroundProgressWaiters = 0;

	constructor(
		protected readonly root: string,
		protected readonly server: ResolvedServer,
	) {}

	pid(): number | undefined {
		return this.proc?.pid;
	}

	command(): string[] {
		return [...this.server.command];
	}

	async start(): Promise<void> {
		const env: Record<string, string | undefined> = {
			...process.env,
			...this.server.env,
		};
		const pathValue = process.platform === "win32" ? (env["PATH"] ?? env["Path"] ?? "") : (env["PATH"] ?? "");
		const spawnPath = [pathValue, ...getAdditionalPathBases(this.root)].filter(Boolean).join(delimiter);
		if (process.platform === "win32" && env["Path"] !== undefined) {
			env["Path"] = spawnPath;
		}
		env["PATH"] = spawnPath;

		this.proc = spawnProcess(this.server.command, {
			cwd: this.root,
			env,
		});
		this.startStderrReading();

		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		if (this.proc.exitCode !== null) {
			const stderr = this.stderrBuffer.join("\n");
			throw new LspProcessExitedError(this.server.id, this.root, this.proc.exitCode, stderr.slice(-2000));
		}

		this.connection = createMessageConnection(
			new StreamMessageReader(this.proc.stdout),
			new StreamMessageWriter(this.proc.stdin),
		);

		this.attachConnectionHandlers(this.connection);
		this.connection.listen();
	}

	protected attachConnectionHandlers(connection: MessageConnection): void {
		connection.onNotification(
			"textDocument/publishDiagnostics",
			(params: { uri?: string; diagnostics?: Diagnostic[] }) => {
				if (params.uri) {
					const key = normalizeUriKey(params.uri);
					this.diagnosticsStore.set(key, params.diagnostics ?? []);
					this.diagnosticsReceivedUris.add(key);
					this.notifyProgressListeners();
				}
			},
		);

		connection.onRequest("workspace/configuration", (params: { items?: Array<{ section?: string }> }) => {
			const items = params?.items ?? [];
			return items.map((item) => {
				if (item.section === "json") return { validate: { enable: true } };
				return {};
			});
		});

		connection.onRequest("client/registerCapability", () => null);
		connection.onRequest("window/workDoneProgress/create", () => null);

		connection.onNotification("$/progress", (params?: ProgressNotification) => {
			const token = params?.token;
			const kind = params?.value?.kind;
			if (token === undefined) return;
			if (kind === "begin") {
				this.hasSeenProgress = true;
				this.activeProgressTokens.add(token);
				this.notifyProgressListeners();
			} else if (kind === "end") {
				this.activeProgressTokens.delete(token);
				this.notifyProgressListeners();
			}
		});

		connection.onClose(() => {
			this.processExited = true;
			this.activeProgressTokens.clear();
			this.notifyProgressListeners();
		});

		connection.onError(() => {});
	}

	protected notifyProgressListeners(): void {
		for (const listener of [...this.progressListeners]) {
			listener();
		}
	}

	/**
	 * Keep any active background progress wait timer ref'd while a foreground
	 * caller is awaiting this client's initialization, so Node doesn't exit
	 * mid-await when the LSP child process and its stdio pipes are unref'd.
	 */
	refProgressWait(): void {
		this.foregroundProgressWaiters++;
		for (const timer of this.backgroundWaitTimers) {
			if (typeof timer.ref === "function") {
				timer.ref();
			}
		}
	}

	unrefProgressWait(): void {
		if (this.foregroundProgressWaiters > 0) {
			this.foregroundProgressWaiters--;
		}
		if (this.foregroundProgressWaiters === 0) {
			for (const timer of this.backgroundWaitTimers) {
				if (typeof timer.unref === "function") {
					timer.unref();
				}
			}
		}
	}

	protected waitForProgressCondition(
		predicate: () => boolean,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { background?: boolean },
	): Promise<boolean> {
		if (predicate()) return Promise.resolve(true);
		if (!this.connection || !this.isAlive()) return Promise.resolve(false);
		if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

		return new Promise<boolean>((resolve, reject) => {
			let settled = false;
			const isBackground = options?.background === true;

			const cleanup = () => {
				clearTimeout(timer);
				if (isBackground) {
					this.backgroundWaitTimers.delete(timer);
				}
				this.progressListeners.delete(onEvent);
				signal?.removeEventListener("abort", onAbort);
			};

			const onEvent = () => {
				if (settled) return;
				if (predicate()) {
					settled = true;
					cleanup();
					resolve(true);
				} else if (!this.isAlive()) {
					settled = true;
					cleanup();
					resolve(false);
				}
			};

			const onAbort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new DOMException("Aborted", "AbortError"));
			};

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(predicate());
			}, timeoutMs);
			if (isBackground) {
				this.backgroundWaitTimers.add(timer);
				if (this.foregroundProgressWaiters === 0 && typeof timer.unref === "function") {
					timer.unref();
				}
			}

			this.progressListeners.add(onEvent);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async waitForActiveProgress(
		timeoutMs?: number,
		signal?: AbortSignal,
		options?: { background?: boolean },
	): Promise<void> {
		if (this.activeProgressTokens.size === 0) return;
		const waitedTokens = [...this.activeProgressTokens];
		const completed = await this.waitForProgressCondition(
			() => this.activeProgressTokens.size === 0 || !this.isAlive(),
			timeoutMs ?? this.server.initTimeoutMs ?? INIT_TIMEOUT_MS,
			signal,
			options,
		);
		// If the wait timed out, evict the stuck tokens so a server that began a
		// progress token and never sends `end` cannot stall subsequent calls.
		if (!completed) {
			for (const token of waitedTokens) {
				this.activeProgressTokens.delete(token);
			}
		}
	}

	protected startStderrReading(): void {
		if (!this.proc) return;
		this.proc.stderr.setEncoding("utf-8");
		this.proc.stderr.on("data", (chunk: string) => {
			this.stderrBuffer.push(chunk);
			if (this.stderrBuffer.length > 100) {
				this.stderrBuffer.shift();
			}
		});
	}

	private isConnectionClosedError(error: unknown): error is Error {
		if (!(error instanceof Error)) {
			return false;
		}
		const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		return (
			code === "ERR_STREAM_DESTROYED" ||
			/connection closed|connection is disposed|stream was destroyed/i.test(error.message)
		);
	}

	protected sendRequest<T>(method: string): Promise<T>;
	protected sendRequest<T>(method: string, params: unknown): Promise<T>;
	protected async sendRequest<T>(method: string, ...args: [] | [unknown]): Promise<T> {
		if (!this.connection) throw new Error("LSP client not started");

		if (this.processExited || (this.proc && this.proc.exitCode !== null)) {
			const stderrTail = this.stderrBuffer.slice(-10).join("\n");
			throw new LspProcessExitedError(
				this.server.id,
				this.root,
				this.proc?.exitCode ?? null,
				stderrTail || undefined,
			);
		}

		let timeoutHandle: NodeJS.Timeout | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				const stderrTail = this.stderrBuffer.slice(-5).join("\n");
				reject(new LspRequestTimeoutError(method, stderrTail || undefined));
			}, this.server.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
		});

		try {
			const requestPromise = (this.connection.sendRequest as <R>(...a: unknown[]) => Promise<R>)<T>(method, ...args);
			const result = await Promise.race([requestPromise, timeoutPromise]);
			if (timeoutHandle !== null) clearTimeout(timeoutHandle);
			return result;
		} catch (error) {
			if (timeoutHandle !== null) clearTimeout(timeoutHandle);
			if (this.processExited || (this.proc && this.proc.exitCode !== null)) {
				throw new LspProcessExitedError(
					this.server.id,
					this.root,
					this.proc?.exitCode ?? null,
					this.stderrBuffer.slice(-10).join("\n") || undefined,
				);
			}
			if (this.isConnectionClosedError(error)) {
				throw new LspConnectionClosedError(this.server.id, this.root, error.message);
			}
			throw error;
		}
	}

	protected sendNotification(method: string): Promise<void>;
	protected sendNotification(method: string, params: unknown): Promise<void>;
	protected async sendNotification(method: string, ...args: [] | [unknown]): Promise<void> {
		if (!this.connection) return;
		if (this.processExited || (this.proc && this.proc.exitCode !== null)) return;
		try {
			await (this.connection.sendNotification as (...a: unknown[]) => Promise<void>)(method, ...args);
		} catch (error) {
			if (this.isConnectionClosedError(error)) {
				throw new LspConnectionClosedError(this.server.id, this.root, error.message);
			}
			throw error;
		}
	}

	isAlive(): boolean {
		return this.proc !== null && !this.processExited && this.proc.exitCode === null;
	}

	/**
	 * Synchronously kill the underlying LSP child process tree.
	 *
	 * Intended for last-resort cleanup paths where async work cannot run to
	 * completion — specifically the `process.on("exit", …)` handler installed
	 * by `LspManager`. `process.on("exit")` is synchronous-only: any awaits
	 * inside it are silently dropped, so `await stop()` never sends SIGTERM and
	 * because we spawn children with `detached: true` they get reparented to
	 * init and block on epoll_wait against a closed stdin pipe forever.
	 *
	 * This method:
	 *   - does NOT send LSP `shutdown` / `exit` (those require async IO)
	 *   - does NOT dispose the JSON-RPC connection (that would queue async work)
	 *   - DOES synchronously deliver SIGTERM to the entire child process group
	 *     via the platform-appropriate kill in `process.ts`
	 *
	 * For graceful cleanup, prefer `stop()`.
	 */
	killSync(): void {
		const proc = this.proc;
		if (!proc) {
			this.processExited = true;
			return;
		}
		this.proc = null;
		this.processExited = true;
		try {
			proc.kill("SIGTERM");
		} catch {}
		this.diagnosticsStore.clear();
		this.activeProgressTokens.clear();
		this.diagnosticsReceivedUris.clear();
		this.notifyProgressListeners();
	}

	async stop(): Promise<void> {
		if (this.connection) {
			try {
				await this.sendRequest<null>("shutdown");
			} catch {}
			try {
				await this.sendNotification("exit");
			} catch {}
			try {
				this.connection.dispose();
			} catch {}
			this.connection = null;
		}

		const proc = this.proc;
		if (proc) {
			this.proc = null;
			let exitedBeforeTimeout = false;
			try {
				proc.kill();
				let timeoutId: NodeJS.Timeout | undefined;
				const timeoutPromise = new Promise<void>((resolve) => {
					timeoutId = setTimeout(resolve, STOP_HARD_KILL_TIMEOUT_MS);
				});
				await Promise.race([
					proc.exited
						.then(() => {
							exitedBeforeTimeout = true;
						})
						.finally(() => {
							if (timeoutId) clearTimeout(timeoutId);
						}),
					timeoutPromise,
				]);
				if (!exitedBeforeTimeout) {
					try {
						proc.kill("SIGKILL");
						await Promise.race([
							proc.exited,
							new Promise<void>((resolve) => setTimeout(resolve, STOP_SIGKILL_GRACE_MS)),
						]);
					} catch {}
				}
			} catch {}
		}

		this.processExited = true;
		this.diagnosticsStore.clear();
		this.activeProgressTokens.clear();
		this.diagnosticsReceivedUris.clear();
		this.notifyProgressListeners();
	}

	protected hasReceivedDiagnostics(uri: string): boolean {
		const key = normalizeUriKey(uri);
		return this.diagnosticsReceivedUris.has(key) || this.diagnosticsReceivedUris.has(uri);
	}

	getStoredDiagnostics(uri: string): Diagnostic[] {
		const key = normalizeUriKey(uri);
		return this.diagnosticsStore.get(key) ?? this.diagnosticsStore.get(uri) ?? [];
	}
}
