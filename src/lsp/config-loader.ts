import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BUILTIN_SERVERS } from "./server-definitions.js";
import type { ResolvedServer } from "./types.js";

// pi's own agent-dir convention. Mirrors @earendil-works/pi-coding-agent's
// getAgentDir() so this extension picks up the same directory pi uses for
// user-scoped configuration. Kept local to avoid a runtime dependency on
// pi-coding-agent internals beyond the documented extension API surface.
const PI_CONFIG_DIR_NAME = ".pi";
const PI_AGENT_DIR_SUBDIR = "agent";
const PI_ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";
const LSP_CONFIG_FILE_NAME = "lsp-client.json";

function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

export function getPiAgentDir(): string {
	const envDir = process.env[PI_ENV_AGENT_DIR];
	if (envDir && envDir.length > 0) {
		return expandTilde(envDir);
	}
	return join(homedir(), PI_CONFIG_DIR_NAME, PI_AGENT_DIR_SUBDIR);
}

interface LspEntry {
	disabled?: boolean;
	command?: string[];
	extensions?: string[];
	priority?: number;
	env?: Record<string, string>;
	initialization?: Record<string, unknown>;
}

interface ConfigJson {
	lsp?: Record<string, LspEntry>;
}

type ConfigSource = "project" | "user";

export interface ServerWithSource extends ResolvedServer {
	source: "project" | "user" | "builtin";
}

export interface ConfigPaths {
	project: string;
	user: string;
	/** Legacy ~/.pi/lsp-client.json path. Kept for backward compatibility with
	 * pre-getAgentDir() releases of this extension. Read only if the primary
	 * user path is missing. */
	userLegacy: string;
}

export function getConfigPaths(): ConfigPaths {
	const cwd = process.cwd();
	return {
		project: join(cwd, PI_CONFIG_DIR_NAME, LSP_CONFIG_FILE_NAME),
		user: join(getPiAgentDir(), LSP_CONFIG_FILE_NAME),
		userLegacy: join(homedir(), PI_CONFIG_DIR_NAME, LSP_CONFIG_FILE_NAME),
	};
}

function loadJsonFile(path: string): ConfigJson | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ConfigJson;
	} catch {
		return null;
	}
}

export function loadAllConfigs(): Map<ConfigSource, ConfigJson> {
	const paths = getConfigPaths();
	const configs = new Map<ConfigSource, ConfigJson>();

	const project = loadJsonFile(paths.project);
	if (project) configs.set("project", project);

	const user = loadJsonFile(paths.user) ?? loadJsonFile(paths.userLegacy);
	if (user) configs.set("user", user);

	return configs;
}

export function getMergedServers(): ServerWithSource[] {
	const configs = loadAllConfigs();
	const servers: ServerWithSource[] = [];
	const disabled = new Set<string>();
	const seen = new Set<string>();

	const sources: ConfigSource[] = ["project", "user"];

	for (const source of sources) {
		const config = configs.get(source);
		if (!config?.lsp) continue;

		for (const [id, entry] of Object.entries(config.lsp)) {
			if (entry.disabled) {
				disabled.add(id);
				continue;
			}

			if (seen.has(id)) continue;
			if (!entry.command || !entry.extensions) continue;

			servers.push({
				id,
				command: entry.command,
				extensions: entry.extensions,
				priority: entry.priority ?? 0,
				...(entry.env !== undefined ? { env: entry.env } : {}),
				...(entry.initialization !== undefined ? { initialization: entry.initialization } : {}),
				source,
			});
			seen.add(id);
		}
	}

	for (const [id, config] of Object.entries(BUILTIN_SERVERS)) {
		if (disabled.has(id) || seen.has(id)) continue;

		servers.push({
			id,
			command: config.command,
			extensions: config.extensions,
			priority: -100,
			source: "builtin",
		});
	}

	return servers.sort((a, b) => {
		if (a.source !== b.source) {
			const order: Record<"project" | "user" | "builtin", number> = {
				project: 0,
				user: 1,
				builtin: 2,
			};
			return order[a.source] - order[b.source];
		}
		return b.priority - a.priority;
	});
}

export function getDisabledServerIds(): Set<string> {
	const configs = loadAllConfigs();
	const disabled = new Set<string>();

	for (const config of configs.values()) {
		if (!config.lsp) continue;
		for (const [id, entry] of Object.entries(config.lsp)) {
			if (entry.disabled) disabled.add(id);
		}
	}

	return disabled;
}
