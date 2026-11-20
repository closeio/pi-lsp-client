import { afterEach, describe, expect, it } from "vitest";

import {
	disposeManagerForSession,
	disposeSharedManager,
	getManagerForSession,
	hasManagerForSession,
	SHARED_POOL_SYMBOL,
} from "../src/lsp/manager-registry.js";

afterEach(async () => {
	await disposeSharedManager();
});

describe("manager-registry", () => {
	it("#given two different session keys #when getManagerForSession #then returns the same shared manager", () => {
		// given
		const sessionA = {};
		const sessionB = {};

		// when
		const managerA = getManagerForSession(sessionA);
		const managerB = getManagerForSession(sessionB);

		// then
		expect(managerA).toBe(managerB);
		expect(hasManagerForSession(sessionA)).toBe(true);
		expect(hasManagerForSession(sessionB)).toBe(true);
		expect(SHARED_POOL_SYMBOL in globalThis).toBe(true);
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

	it("#given a registered session #when disposeManagerForSession #then unregisters session without killing shared manager", async () => {
		// given
		const sessionA = {};
		const sessionB = {};
		const managerA = getManagerForSession(sessionA);
		const managerB = getManagerForSession(sessionB);
		expect(hasManagerForSession(sessionA)).toBe(true);

		// when
		await disposeManagerForSession(sessionA);

		// then: sessionA is unregistered, but sessionB and a later sessionC reuse the same live manager
		expect(hasManagerForSession(sessionA)).toBe(false);
		expect(hasManagerForSession(sessionB)).toBe(true);
		expect(getManagerForSession(sessionB)).toBe(managerB);
		expect(getManagerForSession({})).toBe(managerA);
	});

	it("#given active shared manager #when disposeSharedManager #then clears global slot and next call creates a fresh manager", async () => {
		// given
		const sessionA = {};
		const first = getManagerForSession(sessionA);

		// when
		await disposeSharedManager();

		// then
		expect(hasManagerForSession(sessionA)).toBe(false);
		expect(SHARED_POOL_SYMBOL in globalThis).toBe(false);
		const second = getManagerForSession(sessionA);
		expect(second).not.toBe(first);
	});

	it("#given no registered session #when disposeManagerForSession #then resolves without error", async () => {
		// given
		const sessionA = {};

		// when / then
		await expect(disposeManagerForSession(sessionA)).resolves.toBeUndefined();
		expect(hasManagerForSession(sessionA)).toBe(false);
	});
});
