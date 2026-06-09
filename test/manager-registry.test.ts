import { describe, expect, it } from "vitest";

import { disposeManagerForSession, getManagerForSession, hasManagerForSession } from "../src/lsp/manager-registry.js";

describe("manager-registry", () => {
	it("#given two different session keys #when getManagerForSession #then returns distinct managers", () => {
		// given
		const sessionA = {};
		const sessionB = {};

		// when
		const managerA = getManagerForSession(sessionA);
		const managerB = getManagerForSession(sessionB);

		// then
		expect(managerA).not.toBe(managerB);
	});

	it("#given the same session key #when getManagerForSession called twice #then returns the same manager", () => {
		// given
		const sessionA = {};

		// when
		const first = getManagerForSession(sessionA);
		const second = getManagerForSession(sessionA);

		// then
		expect(first).toBe(second);
	});

	it("#given a registered session #when disposeManagerForSession #then registry no longer has it", async () => {
		// given
		const sessionA = {};
		getManagerForSession(sessionA);
		expect(hasManagerForSession(sessionA)).toBe(true);

		// when
		await disposeManagerForSession(sessionA);

		// then
		expect(hasManagerForSession(sessionA)).toBe(false);
	});

	it("#given two sessions #when one is disposed #then the other survives", async () => {
		// given
		const sessionA = {};
		const sessionB = {};
		const managerA = getManagerForSession(sessionA);
		const managerB = getManagerForSession(sessionB);

		// when
		await disposeManagerForSession(sessionA);

		// then
		expect(hasManagerForSession(sessionA)).toBe(false);
		expect(hasManagerForSession(sessionB)).toBe(true);
		// re-fetching B returns the same instance (not a fresh one)
		expect(getManagerForSession(sessionB)).toBe(managerB);
		// re-fetching A creates a fresh manager (not the disposed one)
		expect(getManagerForSession(sessionA)).not.toBe(managerA);

		// cleanup
		await disposeManagerForSession(sessionA);
		await disposeManagerForSession(sessionB);
	});

	it("#given no registered session #when disposeManagerForSession #then resolves without error", async () => {
		// given
		const sessionA = {};

		// when / then
		await expect(disposeManagerForSession(sessionA)).resolves.toBeUndefined();
		expect(hasManagerForSession(sessionA)).toBe(false);
	});
});
