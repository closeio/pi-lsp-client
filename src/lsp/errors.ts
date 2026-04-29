export class LspConnectionClosedError extends Error {
	override readonly name = "LspConnectionClosedError";

	constructor(
		readonly serverId: string,
		readonly root: string,
		message?: string,
	) {
		super(message ?? `LSP connection closed for ${serverId} at ${root}`);
	}
}

export class LspProcessExitedError extends Error {
	override readonly name = "LspProcessExitedError";

	constructor(
		readonly serverId: string,
		readonly root: string,
		readonly exitCode: number | null,
		readonly stderrTail?: string,
	) {
		const stderrSuffix = stderrTail ? `\nstderr tail: ${stderrTail}` : "";
		super(`LSP server ${serverId} at ${root} exited with code ${exitCode ?? "null"}${stderrSuffix}`);
	}
}

export function isLspDeadConnectionError(err: unknown): err is LspConnectionClosedError | LspProcessExitedError {
	return err instanceof LspConnectionClosedError || err instanceof LspProcessExitedError;
}
