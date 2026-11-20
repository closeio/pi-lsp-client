import { isLspProcessExitedError } from "./errors.js";

const RUST_SRC_REPAIR_MESSAGE = [
	"rust-analyzer exited while loading Rust standard library sources.",
	"",
	"Repair rust-src for the active toolchain:",
	"  rustup component remove rust-src",
	"  rustup component add rust-src",
];

export function shorten(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatKnownLspStartupFailure(error: unknown): string | null {
	if (!isLspProcessExitedError(error)) return null;
	if (error.serverId !== "rust") return null;

	const details = error.stderrTail ?? error.message;
	const lowerDetails = details.toLowerCase();
	const isRustSrcFailure =
		lowerDetails.includes("rust-src") &&
		(lowerDetails.includes("failed to install component") ||
			lowerDetails.includes("detected conflict") ||
			lowerDetails.includes("can't load standard library") ||
			lowerDetails.includes("try installing") ||
			lowerDetails.includes("sysroot"));

	if (!isRustSrcFailure) return null;

	return [...RUST_SRC_REPAIR_MESSAGE, "", "Original stderr tail:", details].join("\n");
}

export function handleMissingDependencyError(error: unknown): string | null {
	const knownStartupFailure = formatKnownLspStartupFailure(error);
	if (knownStartupFailure) return knownStartupFailure;

	const message = errorMessage(error);
	return message.includes("NOT INSTALLED") || message.includes("No LSP server configured") ? message : null;
}

export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			reject(new DOMException("Aborted", "AbortError"));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}
