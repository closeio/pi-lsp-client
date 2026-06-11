import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import type { LspClient } from "./client.js";
import { NOT_READY_RETRY_INTERVAL_MS, NOT_READY_RETRY_TIMEOUT_MS } from "./constants.js";
import {
	isLspDeadConnectionError,
	LspInvalidPathError,
	LspRequestTimeoutError,
	LspServerInitializingError,
	LspServerLookupError,
} from "./errors.js";
import type { LspManager } from "./manager.js";
import { getServerReadiness, isNotReadyError } from "./readiness.js";
import { findServerForExtension } from "./server-resolution.js";
import type { ServerLookupResult } from "./types.js";

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("Aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Self-heal a call that lands while the server's project/index is still loading
// (the signal differs per server - see readiness.ts). Retries the same call on
// the same client for a bounded window, then surfaces a clear "initializing"
// error instead of the server's raw (often cryptic) loading error.
async function callWithNotReadyRetry<T>(
	client: LspClient,
	fn: (client: LspClient) => Promise<T>,
	serverId: string,
	signal: AbortSignal | undefined,
): Promise<T> {
	const deadline = Date.now() + NOT_READY_RETRY_TIMEOUT_MS;
	for (;;) {
		try {
			return await fn(client);
		} catch (err) {
			if (!isNotReadyError(err, serverId)) throw err;
			if (Date.now() >= deadline) {
				throw new LspServerInitializingError(err instanceof Error ? err : new Error(String(err)));
			}
			signal?.throwIfAborted();
			await abortableSleep(NOT_READY_RETRY_INTERVAL_MS, signal);
		}
	}
}

const WORKSPACE_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle"];

export function isDirectoryPath(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

export function findWorkspaceRoot(filePath: string): string {
	const abs = resolve(filePath);
	let dir = abs;

	if (!isDirectoryPath(dir)) {
		dir = dirname(dir);
	}

	let prevDir = "";
	while (dir !== prevDir) {
		for (const marker of WORKSPACE_MARKERS) {
			if (existsSync(join(dir, marker))) {
				return dir;
			}
		}
		prevDir = dir;
		dir = dirname(dir);
	}

	return dirname(abs);
}

export function formatServerLookupError(result: Exclude<ServerLookupResult, { status: "found" }>): string {
	if (result.status === "not_installed") {
		const { server, installHint } = result;
		return [
			`LSP server '${server.id}' is configured but NOT INSTALLED.`,
			"",
			`Command not found: ${server.command[0]}`,
			"",
			"To install:",
			`  ${installHint}`,
			"",
			`Supported extensions: ${server.extensions.join(", ")}`,
			"",
			"After installation, the server will be available automatically.",
		].join("\n");
	}

	return [
		`No LSP server configured for extension: ${result.extension}`,
		"",
		`Available servers: ${result.availableServers.slice(0, 10).join(", ")}${
			result.availableServers.length > 10 ? "..." : ""
		}`,
		"",
		"Configure a custom server in '.pi/lsp-client.json':",
		"  {",
		'    "lsp": {',
		'      "my-server": {',
		'        "command": ["my-lsp", "--stdio"],',
		`        "extensions": ["${result.extension}"]`,
		"      }",
		"    }",
		"  }",
	].join("\n");
}

export interface WithLspClientOptions {
	signal?: AbortSignal;
	/**
	 * The session-scoped LspManager. Required - callers should obtain it
	 * via `getManagerForSession(ctx.sessionManager)` so each pi session
	 * owns its own LSP server pool.
	 */
	manager: LspManager;
	/**
	 * Pi's `onUpdate` callback for the calling tool. When provided, fires
	 * a `tool_execution_update` with `{ lspServer: { id } }` once the
	 * server is resolved, so progress formatters can inline the server id
	 * into the per-call log line (e.g. `lsp_symbols (ty): query`). The
	 * callback's actual type from pi is
	 * `AgentToolUpdateCallback<TDetails>`, which structurally expects a
	 * full `AgentToolResult<TDetails>`; the runtime event delivery only
	 * needs the partial payload sent here, so the parameter is typed as
	 * `unknown` and the call is cast.
	 */
	onUpdate?: unknown;
}

const READ_ONLY_RETRY_TOOLS = new Set([
	"diagnostics",
	"definition",
	"references",
	"documentSymbols",
	"workspaceSymbols",
	"prepareRename",
]);

export async function withLspClient<T>(
	filePath: string,
	fn: (client: LspClient) => Promise<T>,
	toolName: string,
	options: WithLspClientOptions,
): Promise<T> {
	const absPath = resolve(filePath);

	if (isDirectoryPath(absPath)) {
		throw new LspInvalidPathError(
			"Directory paths are not supported by this LSP tool. " +
				"Use lsp_diagnostics with a directory path for directory diagnostics.",
		);
	}

	const ext = extname(absPath);
	const result = findServerForExtension(ext);
	if (result.status !== "found") {
		throw new LspServerLookupError(formatServerLookupError(result));
	}

	const server = result.server;
	const root = findWorkspaceRoot(absPath);
	const manager = options.manager;
	if (typeof options.onUpdate === "function") {
		(options.onUpdate as (arg: unknown) => void)({ lspServer: { id: server.id } });
	}

	const acquireAndCall = async (allowRetry: boolean): Promise<T> => {
		const client = await manager.getClient(root, server, options.signal);

		try {
			// Bootstrap servers whose project/program is created lazily on first
			// `textDocument/didOpen` (typescript, vtsls) so workspace-scoped tools
			// like workspace/symbol have a project to resolve against. openFile is
			// idempotent for callers that open the file themselves.
			if (getServerReadiness(server.id)?.requiresOpenFileToInitProject) {
				await client.openFile(absPath);
			}
			return await callWithNotReadyRetry(client, fn, server.id, options.signal);
		} catch (err) {
			if (allowRetry && READ_ONLY_RETRY_TOOLS.has(toolName) && isLspDeadConnectionError(err)) {
				manager.invalidateClient(root, server.id, client);
				return acquireAndCall(false);
			}

			if (err instanceof LspRequestTimeoutError) {
				if (manager.isServerInitializing(root, server.id)) {
					throw new LspServerInitializingError(err);
				}
			}
			throw err;
		} finally {
			manager.releaseClient(root, server.id);
		}
	};

	return acquireAndCall(true);
}
