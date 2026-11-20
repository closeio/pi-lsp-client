import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import registerExtension from "../src/index.js";
import { disposeSharedManager, getManagerForSession } from "../src/lsp/manager-registry.js";
import type { ResolvedServer } from "../src/lsp/types.js";

interface Notification {
	message: string;
	level: string | undefined;
}

let sandbox: string;
let projectDir: string;
const sessionManager = {};

function captureLspCommand(): RegisteredCommand["handler"] {
	let handler: RegisteredCommand["handler"] | undefined;
	const pi = {
		registerTool: () => {},
		on: () => {},
		registerCommand: (name: string, options: { handler: RegisteredCommand["handler"] }) => {
			if (name === "lsp") handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	registerExtension(pi);
	if (!handler) throw new Error("expected /lsp command to be registered");
	return handler;
}

function contextWithNotifications(notifications: Notification[]): ExtensionCommandContext {
	return {
		cwd: projectDir,
		hasUI: false,
		sessionManager,
		ui: {
			notify(message: string, level?: string): void {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionCommandContext;
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-lsp-warmup-"));
	projectDir = join(sandbox, "project");
	const homeDir = join(sandbox, "home");
	mkdirSync(join(projectDir, ".pi"), { recursive: true });
	mkdirSync(homeDir, { recursive: true });
	vi.spyOn(process, "cwd").mockReturnValue(projectDir);
	vi.stubEnv("HOME", homeDir);
	vi.stubEnv("USERPROFILE", homeDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await disposeSharedManager();
	rmSync(sandbox, { recursive: true, force: true });
});

describe("/lsp warmup", () => {
	it("#given a custom server in project config #when warming it up #then the manager receives the configured server", async () => {
		// given
		writeFileSync(
			join(projectDir, ".pi", "lsp-client.json"),
			JSON.stringify({
				lsp: { raku: { command: ["raku-language-server"], extensions: [".raku"], initTimeoutMs: 120_000 } },
			}),
		);
		const warmedUp: Array<{ root: string; server: ResolvedServer }> = [];
		vi.spyOn(getManagerForSession(sessionManager), "warmupClient").mockImplementation((root, server) => {
			warmedUp.push({ root, server });
		});
		const handler = captureLspCommand();
		const notifications: Notification[] = [];

		// when
		await handler("warmup raku", contextWithNotifications(notifications));

		// then
		expect(warmedUp).toHaveLength(1);
		expect(warmedUp[0]?.root).toBe(projectDir);
		expect(warmedUp[0]?.server).toMatchObject({
			id: "raku",
			command: ["raku-language-server"],
			extensions: [".raku"],
			initTimeoutMs: 120_000,
		});
		expect(notifications).toEqual([{ message: "Warming up 'raku' in background", level: "info" }]);
	});

	it("#given a builtin server #when warming it up #then the builtin definition is used", async () => {
		// given
		const warmedUp: ResolvedServer[] = [];
		vi.spyOn(getManagerForSession(sessionManager), "warmupClient").mockImplementation((_root, server) => {
			warmedUp.push(server);
		});
		const handler = captureLspCommand();
		const notifications: Notification[] = [];

		// when
		await handler("warmup typescript", contextWithNotifications(notifications));

		// then
		expect(warmedUp).toHaveLength(1);
		expect(warmedUp[0]?.id).toBe("typescript");
		expect(warmedUp[0]?.command[0]).toBe("typescript-language-server");
	});

	it("#given an id that is neither builtin nor configured #when warming it up #then it reports an unknown id", async () => {
		// given
		const warmup = vi.spyOn(getManagerForSession(sessionManager), "warmupClient").mockImplementation(() => {});
		const handler = captureLspCommand();
		const notifications: Notification[] = [];

		// when
		await handler("warmup does-not-exist", contextWithNotifications(notifications));

		// then
		expect(warmup).not.toHaveBeenCalled();
		expect(notifications).toEqual([{ message: "Unknown server id 'does-not-exist'.", level: "error" }]);
	});

	it("#given a workspace with source and config files #when warming up typescript #then passes a non-config seed file", async () => {
		// given
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, "vitest.config.ts"), "export default {};\n");
		writeFileSync(join(projectDir, "src", "app.ts"), "export const x = 1;\n");
		const calls: Array<{ root: string; server: ResolvedServer; seedFile: string | undefined }> = [];
		vi.spyOn(getManagerForSession(sessionManager), "warmupClient").mockImplementation((root, server, seedFile) => {
			calls.push({ root, server, seedFile });
		});
		const handler = captureLspCommand();
		const notifications: Notification[] = [];

		// when
		await handler("warmup typescript", contextWithNotifications(notifications));

		// then
		expect(calls).toHaveLength(1);
		expect(calls[0]?.seedFile).toBe(join(projectDir, "src", "app.ts"));
	});

	it("#given dot-directories containing source files #when warming up typescript #then skips dot-directories and picks project source", async () => {
		// given
		mkdirSync(join(projectDir, ".github", "actions"), { recursive: true });
		mkdirSync(join(projectDir, ".cache", "tools"), { recursive: true });
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, ".github", "actions", "check.test.ts"), "export const a = 1;\n");
		writeFileSync(join(projectDir, ".cache", "tools", "generated.ts"), "export const b = 2;\n");
		writeFileSync(join(projectDir, "src", "main.ts"), "export const c = 3;\n");
		const calls: Array<{ root: string; server: ResolvedServer; seedFile: string | undefined }> = [];
		vi.spyOn(getManagerForSession(sessionManager), "warmupClient").mockImplementation((root, server, seedFile) => {
			calls.push({ root, server, seedFile });
		});
		const handler = captureLspCommand();
		const notifications: Notification[] = [];

		// when
		await handler("warmup typescript", contextWithNotifications(notifications));

		// then
		expect(calls).toHaveLength(1);
		expect(calls[0]?.seedFile).toBe(join(projectDir, "src", "main.ts"));
	});
});

describe("session_start background warmup", () => {
	it("#given a project with a configured server #when session_start fires #then warms up with a seed file", async () => {
		// given
		mkdirSync(join(projectDir, "src"), { recursive: true });
		writeFileSync(join(projectDir, "package.json"), "{}");
		writeFileSync(join(projectDir, "src", "app.ts"), "export const x = 1;\n");
		writeFileSync(
			join(projectDir, ".pi", "lsp-client.json"),
			JSON.stringify({
				lsp: { typescript: { command: ["node"], extensions: [".ts"] } },
			}),
		);
		let sessionStartHandler: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
				if (event === "session_start") sessionStartHandler = handler;
			},
		} as unknown as ExtensionAPI;
		registerExtension(pi);
		if (!sessionStartHandler) throw new Error("expected session_start handler");

		const calls: Array<{ root: string; server: ResolvedServer; seedFile: string | undefined }> = [];
		vi.spyOn(getManagerForSession(sessionManager), "warmupClient").mockImplementation((root, server, seedFile) => {
			calls.push({ root, server, seedFile });
		});

		// when
		await sessionStartHandler(
			{ type: "session_start" },
			{
				cwd: projectDir,
				sessionManager,
				ui: { setStatus: () => {}, theme: { fg: (_c: string, s: string) => s } },
			},
		);

		// then
		expect(calls).toHaveLength(1);
		expect(calls[0]?.root).toBe(projectDir);
		expect(calls[0]?.server.id).toBe("typescript");
		expect(calls[0]?.seedFile).toBe(join(projectDir, "src", "app.ts"));
	});
});
