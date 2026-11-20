import { LspClient } from "./client.js";
import { IDLE_TIMEOUT_MS, INIT_TIMEOUT_MS, REAPER_INTERVAL_MS } from "./constants.js";
import { getServerReadiness } from "./readiness.js";
import type { ResolvedServer } from "./types.js";
import { awaitWithSignal } from "./utils.js";

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function serverConfigFingerprint(server: ResolvedServer): string {
	return canonicalJson({
		command: server.command,
		env: server.env,
		initialization: server.initialization,
		requestTimeoutMs: server.requestTimeoutMs,
		initTimeoutMs: server.initTimeoutMs,
	});
}

interface ManagedClient {
	client: LspClient;
	configFingerprint: string;
	refCount: number;
	pendingWaiters: number;
	lastUsedAt: number;
	initPromise: Promise<void> | null;
	isInitializing: boolean;
	initializingSince: number | null;
	/** In-flight background project load triggered by warmupClient; tracked separately from initialize(). */
	projectLoadPromise: Promise<void> | null;
	/** Effective init timeout for this specific client: server.initTimeoutMs ?? manager default. */
	initTimeoutMs: number;
}

export interface ClientSnapshot {
	root: string;
	serverId: string;
	refCount: number;
	pendingWaiters: number;
	lastUsedAt: number;
	isInitializing: boolean;
	alive: boolean;
	command: string[];
}

export interface LspManagerOptions {
	idleTimeoutMs?: number;
	initTimeoutMs?: number;
	reaperIntervalMs?: number;
	clientFactory?: (root: string, server: ResolvedServer) => LspClient;
	now?: () => number;
}

export class LspManager {
	private readonly clients = new Map<string, ManagedClient>();
	private reaperHandle: NodeJS.Timeout | null = null;
	private exitDisposer: (() => void) | null = null;
	private disposed = false;

	private readonly idleTimeoutMs: number;
	private readonly initTimeoutMs: number;
	private readonly reaperIntervalMs: number;
	private readonly clientFactory: (root: string, server: ResolvedServer) => LspClient;
	private readonly now: () => number;

	constructor(options: LspManagerOptions = {}) {
		this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
		this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
		this.reaperIntervalMs = options.reaperIntervalMs ?? REAPER_INTERVAL_MS;
		this.clientFactory = options.clientFactory ?? ((root, server) => new LspClient(root, server));
		this.now = options.now ?? (() => Date.now());

		this.startReaper();
		this.installProcessExitHandler();
	}

	private startReaper(): void {
		if (this.reaperHandle) return;
		this.reaperHandle = setInterval(() => {
			this.reapStale();
		}, this.reaperIntervalMs);
		if (typeof this.reaperHandle.unref === "function") {
			this.reaperHandle.unref();
		}
	}

	private installProcessExitHandler(): void {
		// `process.on("exit", ...)` runs synchronously — awaits inside it are
		// silently dropped. Calling the async `client.stop()` from here never
		// reached `proc.kill()` in practice, so LSP children spawned with
		// `detached: true` (see process.ts) survived parent exit, were reparented
		// to init, and blocked in epoll_wait on their now-closed stdin pipe. Use
		// the synchronous `killSync()` instead so SIGTERM is delivered to the
		// child process group before this Node process tears down.
		const handler = () => {
			for (const managed of this.clients.values()) {
				try {
					managed.client.killSync();
				} catch {}
			}
			this.clients.clear();
		};
		process.on("exit", handler);
		this.exitDisposer = () => {
			process.removeListener("exit", handler);
		};
	}

	private getKey(root: string, serverId: string): string {
		return `${root}::${serverId}`;
	}

	private reapStale(): void {
		const t = this.now();
		for (const [key, managed] of this.clients) {
			if (
				managed.isInitializing &&
				managed.initializingSince !== null &&
				t - managed.initializingSince > managed.initTimeoutMs
			) {
				managed.client.stop().catch(() => {});
				this.clients.delete(key);
				continue;
			}

			if (
				!managed.isInitializing &&
				managed.projectLoadPromise === null &&
				managed.refCount === 0 &&
				managed.pendingWaiters === 0 &&
				t - managed.lastUsedAt > this.idleTimeoutMs
			) {
				managed.client.stop().catch(() => {});
				this.clients.delete(key);
			}
		}
	}

	private async tryDeleteIfOrphaned(key: string, managed: ManagedClient): Promise<void> {
		if (
			managed.refCount === 0 &&
			managed.pendingWaiters === 0 &&
			!managed.isInitializing &&
			managed.projectLoadPromise === null &&
			this.clients.get(key) === managed
		) {
			this.clients.delete(key);
			await managed.client.stop().catch(() => {});
		}
	}

	async getClient(root: string, server: ResolvedServer, signal?: AbortSignal): Promise<LspClient> {
		if (this.disposed) {
			throw new Error("LspManager has been disposed");
		}
		signal?.throwIfAborted();

		const key = this.getKey(root, server.id);
		const configFingerprint = serverConfigFingerprint(server);
		let managed = this.clients.get(key);

		if (managed && managed.configFingerprint !== configFingerprint) {
			if (this.clients.get(key) === managed) {
				this.clients.delete(key);
			}
			await managed.client.stop().catch(() => {});
			managed = undefined;
		}

		if (managed) {
			const t = this.now();
			if (
				managed.isInitializing &&
				managed.initializingSince !== null &&
				t - managed.initializingSince > managed.initTimeoutMs
			) {
				if (this.clients.get(key) === managed) {
					this.clients.delete(key);
				}
				await managed.client.stop().catch(() => {});
				managed = undefined;
			}
		}

		if (managed) {
			if (managed.initPromise) {
				managed.pendingWaiters++;
				managed.client.refProgressWait();
				try {
					await awaitWithSignal(managed.initPromise, signal);
				} catch (err) {
					managed.pendingWaiters--;
					await this.tryDeleteIfOrphaned(key, managed);
					throw err;
				} finally {
					managed.client.unrefProgressWait();
				}
				managed.pendingWaiters--;
			}

			if (signal?.aborted) {
				await this.tryDeleteIfOrphaned(key, managed);
				signal.throwIfAborted();
			}

			if (!managed.client.isAlive()) {
				if (this.clients.get(key) === managed) {
					this.clients.delete(key);
				}
				await managed.client.stop().catch(() => {});
				return this.getClient(root, server, signal);
			}

			managed.refCount++;
			managed.lastUsedAt = this.now();
			return managed.client;
		}

		const client = this.clientFactory(root, server);
		const initStartedAt = this.now();
		const initPromise = (async () => {
			await client.start();
			await client.initialize();
		})();

		const newManaged: ManagedClient = {
			client,
			configFingerprint,
			refCount: 0,
			pendingWaiters: 1,
			lastUsedAt: initStartedAt,
			initPromise,
			isInitializing: true,
			initializingSince: initStartedAt,
			projectLoadPromise: null,
			initTimeoutMs: server.initTimeoutMs ?? this.initTimeoutMs,
		};
		this.clients.set(key, newManaged);

		try {
			await awaitWithSignal(initPromise, signal);
		} catch (err) {
			newManaged.pendingWaiters--;
			if (this.clients.get(key) === newManaged) {
				this.clients.delete(key);
			}
			await client.stop().catch(() => {});
			throw err;
		}

		newManaged.pendingWaiters--;
		newManaged.isInitializing = false;
		newManaged.initializingSince = null;
		newManaged.initPromise = null;

		if (signal?.aborted) {
			await this.tryDeleteIfOrphaned(key, newManaged);
			signal.throwIfAborted();
		}

		newManaged.refCount++;
		newManaged.lastUsedAt = this.now();
		return client;
	}

	releaseClient(root: string, serverId: string): void {
		const key = this.getKey(root, serverId);
		const managed = this.clients.get(key);
		if (managed && managed.refCount > 0) {
			managed.refCount--;
			managed.lastUsedAt = this.now();
		}
	}

	invalidateClient(root: string, serverId: string, client?: LspClient): void {
		const key = this.getKey(root, serverId);
		const managed = this.clients.get(key);
		if (!managed) return;
		if (client && managed.client !== client) return;
		this.clients.delete(key);
		managed.client.stop().catch(() => {});
	}

	warmupClient(root: string, server: ResolvedServer, seedFilePath?: string): void {
		if (this.disposed) return;
		const key = this.getKey(root, server.id);
		const configFingerprint = serverConfigFingerprint(server);
		const existing = this.clients.get(key);
		if (existing) {
			if (existing.configFingerprint === configFingerprint) return;
			this.clients.delete(key);
			existing.client.stop().catch(() => {});
		}

		const client = this.clientFactory(root, server);
		const initStartedAt = this.now();
		const initPromise = (async () => {
			await client.start();
			await client.initialize();
		})();

		const managed: ManagedClient = {
			client,
			configFingerprint,
			refCount: 0,
			pendingWaiters: 0,
			lastUsedAt: initStartedAt,
			initPromise,
			isInitializing: true,
			initializingSince: initStartedAt,
			projectLoadPromise: null,
			initTimeoutMs: server.initTimeoutMs ?? this.initTimeoutMs,
		};
		this.clients.set(key, managed);

		initPromise.then(
			() => {
				managed.isInitializing = false;
				managed.initializingSince = null;
				managed.initPromise = null;
				managed.lastUsedAt = this.now();

				if (
					seedFilePath &&
					!this.disposed &&
					this.clients.get(key) === managed &&
					getServerReadiness(server.id)?.waitForProjectProgress
				) {
					const loadPromise = client
						.waitForProjectReady(seedFilePath, undefined, { background: true })
						.catch(() => {})
						.finally(() => {
							if (managed.projectLoadPromise === loadPromise) {
								managed.projectLoadPromise = null;
								managed.lastUsedAt = this.now();
							}
						});
					managed.projectLoadPromise = loadPromise;
				}
			},
			() => {
				if (this.clients.get(key) === managed) {
					this.clients.delete(key);
				}
				client.stop().catch(() => {});
			},
		);
	}

	isServerInitializing(root: string, serverId: string): boolean {
		const managed = this.clients.get(this.getKey(root, serverId));
		return managed?.isInitializing ?? false;
	}

	getSnapshot(): ClientSnapshot[] {
		const snapshots: ClientSnapshot[] = [];
		for (const [key, managed] of this.clients) {
			const [root, serverId] = key.split("::") as [string, string];
			snapshots.push({
				root,
				serverId,
				refCount: managed.refCount,
				pendingWaiters: managed.pendingWaiters,
				lastUsedAt: managed.lastUsedAt,
				isInitializing: managed.isInitializing,
				alive: managed.client.isAlive(),
				command: managed.client.command(),
			});
		}
		return snapshots;
	}

	hasClient(root: string, serverId: string): boolean {
		return this.clients.has(this.getKey(root, serverId));
	}

	clientCount(): number {
		return this.clients.size;
	}

	async stopAll(): Promise<void> {
		this.disposed = true;

		if (this.reaperHandle) {
			clearInterval(this.reaperHandle);
			this.reaperHandle = null;
		}

		if (this.exitDisposer) {
			this.exitDisposer();
			this.exitDisposer = null;
		}

		const stopPromises: Promise<void>[] = [];
		for (const managed of this.clients.values()) {
			stopPromises.push(managed.client.stop().catch(() => {}));
		}
		this.clients.clear();
		await Promise.allSettled(stopPromises);
	}
}
