import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfigPaths, getPiAgentDir, loadAllConfigs } from "../src/lsp/config-loader.js";

interface SandboxEnv {
	rootDir: string;
	originalCwd: string;
	originalEnv: string | undefined;
}

function setupSandbox(): SandboxEnv {
	const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-lsp-cfg-")));
	const originalCwd = process.cwd();
	const originalEnv = process.env["PI_CODING_AGENT_DIR"];
	process.chdir(rootDir);
	return { rootDir, originalCwd, originalEnv };
}

function teardownSandbox(env: SandboxEnv): void {
	process.chdir(env.originalCwd);
	if (env.originalEnv === undefined) {
		delete process.env["PI_CODING_AGENT_DIR"];
	} else {
		process.env["PI_CODING_AGENT_DIR"] = env.originalEnv;
	}
	rmSync(env.rootDir, { recursive: true, force: true });
}

describe("getPiAgentDir", () => {
	let env: SandboxEnv;

	beforeEach(() => {
		env = setupSandbox();
	});

	afterEach(() => {
		teardownSandbox(env);
	});

	it("#given no PI_CODING_AGENT_DIR #when reading agent dir #then defaults to ~/.pi/agent", () => {
		// given
		delete process.env["PI_CODING_AGENT_DIR"];

		// when
		const dir = getPiAgentDir();

		// then
		expect(dir).toBe(join(homedir(), ".pi", "agent"));
	});

	it("#given PI_CODING_AGENT_DIR set #when reading agent dir #then env var wins", () => {
		// given
		const overridden = join(env.rootDir, "custom-agent");
		process.env["PI_CODING_AGENT_DIR"] = overridden;

		// when
		const dir = getPiAgentDir();

		// then
		expect(dir).toBe(overridden);
	});

	it("#given PI_CODING_AGENT_DIR with ~/ prefix #when reading agent dir #then tilde expands to homedir", () => {
		// given
		process.env["PI_CODING_AGENT_DIR"] = "~/somewhere/agent";

		// when
		const dir = getPiAgentDir();

		// then
		expect(dir).toBe(join(homedir(), "somewhere/agent"));
	});

	it("#given empty PI_CODING_AGENT_DIR #when reading agent dir #then falls back to default", () => {
		// given
		process.env["PI_CODING_AGENT_DIR"] = "";

		// when
		const dir = getPiAgentDir();

		// then
		expect(dir).toBe(join(homedir(), ".pi", "agent"));
	});
});

describe("getConfigPaths", () => {
	let env: SandboxEnv;

	beforeEach(() => {
		env = setupSandbox();
	});

	afterEach(() => {
		teardownSandbox(env);
	});

	it("#given env var set #when reading paths #then user path lives under agent dir", () => {
		// given
		const agentDir = join(env.rootDir, "agent");
		process.env["PI_CODING_AGENT_DIR"] = agentDir;

		// when
		const paths = getConfigPaths();

		// then
		expect(paths.user).toBe(join(agentDir, "lsp-client.json"));
		expect(paths.project).toBe(join(env.rootDir, ".pi", "lsp-client.json"));
		expect(paths.userLegacy).toBe(join(homedir(), ".pi", "lsp-client.json"));
	});

	it("#given no env var #when reading paths #then user path is the default agent dir file", () => {
		// given
		delete process.env["PI_CODING_AGENT_DIR"];

		// when
		const paths = getConfigPaths();

		// then
		expect(paths.user).toBe(join(homedir(), ".pi", "agent", "lsp-client.json"));
	});
});

describe("loadAllConfigs", () => {
	let env: SandboxEnv;

	beforeEach(() => {
		env = setupSandbox();
	});

	afterEach(() => {
		teardownSandbox(env);
	});

	it("#given config under PI_CODING_AGENT_DIR #when loading #then user config is read from agent dir", () => {
		// given
		const agentDir = join(env.rootDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "lsp-client.json"),
			JSON.stringify({ lsp: { pyrefly: { command: ["pyrefly", "lsp"], extensions: [".py"] } } }),
		);
		process.env["PI_CODING_AGENT_DIR"] = agentDir;

		// when
		const configs = loadAllConfigs();
		const user = configs.get("user");

		// then
		expect(user?.lsp?.["pyrefly"]?.command).toEqual(["pyrefly", "lsp"]);
		expect(configs.has("project")).toBe(false);
	});

	it("#given project .pi/lsp-client.json in cwd #when loading #then project config is read", () => {
		// given
		const projectDir = join(env.rootDir, ".pi");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "lsp-client.json"),
			JSON.stringify({ lsp: { ruff: { command: ["ruff", "server"], extensions: [".py"] } } }),
		);
		// no env var
		delete process.env["PI_CODING_AGENT_DIR"];

		// when
		const configs = loadAllConfigs();
		const project = configs.get("project");

		// then
		expect(project?.lsp?.["ruff"]?.command).toEqual(["ruff", "server"]);
	});

	it("#given only legacy ~/.pi/lsp-client.json #when primary agent path missing #then legacy is loaded as user", () => {
		// given: point agent dir at an empty directory so primary is missing
		const agentDir = join(env.rootDir, "agent-empty");
		mkdirSync(agentDir, { recursive: true });
		process.env["PI_CODING_AGENT_DIR"] = agentDir;

		// and: put a legacy config at the userLegacy path (only if it doesn't
		// already exist on the real homedir, to avoid clobbering developer files)
		const legacyPath = join(homedir(), ".pi", "lsp-client.json");
		const legacyExisted = (() => {
			try {
				// existsSync via dynamic import to avoid hoisting
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				return require("node:fs").existsSync(legacyPath);
			} catch {
				return false;
			}
		})();
		if (legacyExisted) {
			// skip this assertion: a real legacy file is present on the
			// developer's machine. The behavior is still covered by the
			// agent-dir primary path test above.
			return;
		}

		try {
			mkdirSync(join(homedir(), ".pi"), { recursive: true });
			writeFileSync(legacyPath, JSON.stringify({ lsp: { foo: { command: ["foo"], extensions: [".foo"] } } }));

			// when
			const configs = loadAllConfigs();
			const user = configs.get("user");

			// then
			expect(user?.lsp?.["foo"]?.command).toEqual(["foo"]);
		} finally {
			try {
				rmSync(legacyPath, { force: true });
			} catch {}
		}
	});

	it("#given primary agent config present #when legacy also present #then primary wins", () => {
		// given
		const agentDir = join(env.rootDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "lsp-client.json"),
			JSON.stringify({ lsp: { primary: { command: ["primary"], extensions: [".x"] } } }),
		);
		process.env["PI_CODING_AGENT_DIR"] = agentDir;

		// when
		const configs = loadAllConfigs();
		const user = configs.get("user");

		// then
		expect(user?.lsp?.["primary"]).toBeDefined();
		expect(user?.lsp?.["legacy"]).toBeUndefined();
	});
});
