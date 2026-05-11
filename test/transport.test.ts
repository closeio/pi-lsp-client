import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

import { LspConnectionClosedError } from "../src/lsp/errors.js";
import { LspClientTransport } from "../src/lsp/transport.js";

import { makeServer } from "./helpers/fake-lsp-client.js";

class NotificationHarness extends LspClientTransport {
	private readonly input = new PassThrough();
	private readonly output = new PassThrough();

	constructor() {
		super("/root/a", makeServer("typescript"));
	}

	installDestroyedConnection(): void {
		const connection: MessageConnection = createMessageConnection(
			new StreamMessageReader(this.input),
			new StreamMessageWriter(this.output),
		);
		connection.listen();
		this.connection = connection;
		this.output.destroy();
	}

	notify(): Promise<void> {
		return this.sendNotification("window/logMessage", { type: 3, message: "test" });
	}

	disposeHarness(): void {
		this.connection?.dispose();
		this.input.destroy();
		this.output.destroy();
	}
}

describe("LspClientTransport", () => {
	it("#given destroyed json-rpc writer #when notification is sent #then write failure rejects to caller", async () => {
		// given
		const harness = new NotificationHarness();
		harness.installDestroyedConnection();

		try {
			// when / then
			await expect(harness.notify()).rejects.toBeInstanceOf(LspConnectionClosedError);
		} finally {
			harness.disposeHarness();
		}
	});
});
