export function shorten(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function handleMissingDependencyError(error: unknown): string | null {
	const message = errorMessage(error);
	return message.includes("NOT INSTALLED") || message.includes("No LSP server configured") ? message : null;
}
