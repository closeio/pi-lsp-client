import { extname } from "node:path";

import { getDisabledServerIds, getMergedServers } from "./config-loader.js";
import { BUILTIN_SERVERS, LSP_INSTALL_HINTS } from "./server-definitions.js";
import { isServerInstalled } from "./server-installation.js";
import type { ServerLookupResult } from "./types.js";

/**
 * Resolve the LSP server id for a file path so callers (renderers,
 * progress emitters) can surface which server will service the request.
 * Returns `null` when the path has no recognizable extension (e.g. the
 * directory paths `lsp_diagnostics` accepts) or when no server is
 * configured for that extension. Cheap: under the hood,
 * `findServerForExtension` reads at most two small JSON config files.
 */
export function resolveServerIdForPath(filePath: string): string | null {
	const ext = extname(filePath);
	if (!ext) return null;
	const result = findServerForExtension(ext);
	if (result.status === "not_configured") return null;
	return result.server.id;
}

export function findServerForExtension(ext: string): ServerLookupResult {
	const servers = getMergedServers();

	for (const server of servers) {
		if (server.extensions.includes(ext) && isServerInstalled(server.command)) {
			return {
				status: "found",
				server: {
					id: server.id,
					command: server.command,
					extensions: server.extensions,
					priority: server.priority,
					...(server.env !== undefined ? { env: server.env } : {}),
					...(server.initialization !== undefined ? { initialization: server.initialization } : {}),
				},
			};
		}
	}

	for (const server of servers) {
		if (server.extensions.includes(ext)) {
			const installHint =
				LSP_INSTALL_HINTS[server.id] ?? `Install '${server.command[0]}' and ensure it's in your PATH`;
			return {
				status: "not_installed",
				server: {
					id: server.id,
					command: server.command,
					extensions: server.extensions,
				},
				installHint,
			};
		}
	}

	const availableServers = [...new Set(servers.map((s) => s.id))];
	return {
		status: "not_configured",
		extension: ext,
		availableServers,
	};
}

export interface ServerStatus {
	id: string;
	installed: boolean;
	extensions: string[];
	disabled: boolean;
	source: string;
	priority: number;
}

export function getAllServers(): ServerStatus[] {
	const servers = getMergedServers();
	const disabled = getDisabledServerIds();

	const result: ServerStatus[] = [];
	const seen = new Set<string>();

	for (const server of servers) {
		if (seen.has(server.id)) continue;
		result.push({
			id: server.id,
			installed: isServerInstalled(server.command),
			extensions: server.extensions,
			disabled: false,
			source: server.source,
			priority: server.priority,
		});
		seen.add(server.id);
	}

	for (const id of disabled) {
		if (seen.has(id)) continue;
		const builtin = BUILTIN_SERVERS[id];
		result.push({
			id,
			installed: builtin ? isServerInstalled(builtin.command) : false,
			extensions: builtin?.extensions ?? [],
			disabled: true,
			source: "disabled",
			priority: 0,
		});
	}

	return result;
}
