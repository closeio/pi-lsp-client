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

export class LspRequestTimeoutError extends Error {
	override readonly name = "LspRequestTimeoutError";

	constructor(
		readonly method: string,
		readonly stderrTail?: string,
	) {
		const stderrSuffix = stderrTail ? `\nrecent stderr: ${stderrTail}` : "";
		super(`LSP request timeout (method: ${method})${stderrSuffix}`);
	}
}

export class LspInvalidPathError extends Error {
	override readonly name = "LspInvalidPathError";
}

export class LspServerLookupError extends Error {
	override readonly name = "LspServerLookupError";
}

export class LspServerInitializingError extends Error {
	override readonly name = "LspServerInitializingError";

	// Accepts any error: raised both when a request times out during init
	// (LspRequestTimeoutError) and when a server keeps reporting "still loading"
	// (project/index not ready) past the retry budget.
	constructor(readonly originalError: Error) {
		super(
			`LSP server is still initializing (loading its project/index). Please retry in a few seconds. Original error: ${originalError.message}`,
		);
	}
}

export class LspProcessSpawnError extends Error {
	override readonly name = "LspProcessSpawnError";
}

export function isLspProcessExitedError(err: unknown): err is LspProcessExitedError {
	return err instanceof LspProcessExitedError || (err instanceof Error && err.name === "LspProcessExitedError");
}

export function isLspConnectionClosedError(err: unknown): err is LspConnectionClosedError {
	return err instanceof LspConnectionClosedError || (err instanceof Error && err.name === "LspConnectionClosedError");
}

export function isLspRequestTimeoutError(err: unknown): err is LspRequestTimeoutError {
	return err instanceof LspRequestTimeoutError || (err instanceof Error && err.name === "LspRequestTimeoutError");
}

export function isLspDeadConnectionError(err: unknown): err is LspConnectionClosedError | LspProcessExitedError {
	return isLspConnectionClosedError(err) || isLspProcessExitedError(err);
}
