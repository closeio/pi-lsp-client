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
 * Session-scoped LspManager registry.
 *
 * Each pi session gets its own LspManager - and therefore its own pool of
 * LSP server subprocesses - keyed by reference identity of the session's
 * `sessionManager`. Concurrent sub-agent sessions in the same Node process
 * do not share clients, so one session's shutdown can never dispose
 * servers that another session is still using.
 *
 * Lifetime contract:
 *   - `getManagerForSession` is lazy: the manager is created on first use.
 *   - `disposeManagerForSession` is called from `session_shutdown` and is
 *     idempotent. It is the ONLY caller-initiated disposal path.
 *   - The WeakMap is keyed by `sessionManager` so a forgotten session can
 *     still be GC'd cleanly; the per-manager `process.on("exit")` hook
 *     remains the belt-and-suspenders for crashes / SIGKILL'd parents.
 */
const _registry = new WeakMap<SessionKey, LspManager>();

export function getManagerForSession(sessionKey: SessionKey): LspManager {
	let m = _registry.get(sessionKey);
	if (!m) {
		m = new LspManager();
		_registry.set(sessionKey, m);
	}
	return m;
}

export async function disposeManagerForSession(sessionKey: SessionKey): Promise<void> {
	const m = _registry.get(sessionKey);
	if (!m) return;
	_registry.delete(sessionKey);
	await m.stopAll();
}

export function hasManagerForSession(sessionKey: SessionKey): boolean {
	return _registry.has(sessionKey);
}
