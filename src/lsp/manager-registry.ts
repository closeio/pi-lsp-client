import { LspManager } from "./manager.js";

/**
 * Reference-equality key for a pi session. `ExtensionContext.sessionManager`
 * is the canonical value to pass - it is created per session, so its object
 * identity scopes the registry entry to that session. The type is widened to
 * `object` here so the registry doesn't need to import pi-coding-agent's
 * internal `ReadonlySessionManager` type (which isn't re-exported from the
 * package's public entry).
 */
export type SessionKey = object;

/**
 * Process-wide symbol key for the shared LSP pool. Using `globalThis` +
 * `Symbol.for` lets concurrent and sequential pi sessions share warm language
 * servers even when pi reloads the extension module per session with
 * `moduleCache: false`.
 */
export const SHARED_POOL_SYMBOL = Symbol.for("pi-lsp-client.shared-pool.v1");

interface SharedLspPool {
	manager: LspManager;
	sessions: WeakSet<SessionKey>;
}

type GlobalWithLspPool = typeof globalThis & {
	[SHARED_POOL_SYMBOL]?: SharedLspPool;
};

function getGlobalStore(): GlobalWithLspPool {
	return globalThis as GlobalWithLspPool;
}

function getOrCreatePool(): SharedLspPool {
	const store = getGlobalStore();
	let pool = store[SHARED_POOL_SYMBOL];
	if (!pool) {
		pool = {
			manager: new LspManager(),
			sessions: new WeakSet<SessionKey>(),
		};
		store[SHARED_POOL_SYMBOL] = pool;
	}
	return pool;
}

/**
 * Return the process-wide shared LspManager and register `sessionKey` as a
 * participant. Sessions share pooled clients keyed by `(root, serverId)` with
 * per-call refCount accounting; idle clients are reaped after `IDLE_TIMEOUT_MS`
 * and killed synchronously on `process.on("exit")`.
 */
export function getManagerForSession(sessionKey: SessionKey): LspManager {
	const pool = getOrCreatePool();
	pool.sessions.add(sessionKey);
	return pool.manager;
}

/**
 * Unregister a session on `session_shutdown`. Intentionally leaves warm shared
 * servers alive so concurrent sessions and subsequent phases in the same Node
 * process reuse them instead of paying cold start again.
 */
export async function disposeManagerForSession(sessionKey: SessionKey): Promise<void> {
	const pool = getGlobalStore()[SHARED_POOL_SYMBOL];
	if (!pool) return;
	pool.sessions.delete(sessionKey);
}

export function hasManagerForSession(sessionKey: SessionKey): boolean {
	const pool = getGlobalStore()[SHARED_POOL_SYMBOL];
	return pool?.sessions.has(sessionKey) ?? false;
}

/**
 * Stop all servers in the process-wide shared pool and clear the `globalThis`
 * slot. Intended for tests and explicit full teardown.
 */
export async function disposeSharedManager(): Promise<void> {
	const store = getGlobalStore();
	const pool = store[SHARED_POOL_SYMBOL];
	if (!pool) return;
	delete store[SHARED_POOL_SYMBOL];
	await pool.manager.stopAll();
}
