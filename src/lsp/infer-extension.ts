import { lstatSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";

import { EXT_TO_LANG } from "./language-mappings.js";

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "out", "venv", "__pycache__", "target", "vendor"]);
const MAX_SCAN_ENTRIES = 500;
const CONFIG_FILE_PATTERN = /\.config\.[^.]+$/i;

function shouldSkipDirectory(entry: string): boolean {
	return entry.startsWith(".") || SKIP_DIRECTORIES.has(entry);
}

function isConfigLikeFile(filename: string): boolean {
	return CONFIG_FILE_PATTERN.test(filename);
}

export interface DirectorySeed {
	extension: string;
	filePath: string;
}

export function inferSeedFilesByFrequency(directory: string): DirectorySeed[] {
	const extensionCounts = new Map<string, number>();
	const firstFileByExtension = new Map<string, string>();
	let scanned = 0;

	function walk(dir: string): void {
		if (scanned >= MAX_SCAN_ENTRIES) return;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (scanned >= MAX_SCAN_ENTRIES) return;

			const fullPath = join(dir, entry);

			let stat: ReturnType<typeof lstatSync> | undefined;
			try {
				stat = lstatSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isSymbolicLink()) continue;
			scanned++;

			if (stat.isDirectory()) {
				if (!shouldSkipDirectory(entry)) {
					walk(fullPath);
				}
			} else if (stat.isFile()) {
				const ext = extname(fullPath);
				if (ext && ext in EXT_TO_LANG) {
					extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
					const existing = firstFileByExtension.get(ext);
					if (!existing || (isConfigLikeFile(existing) && !isConfigLikeFile(entry))) {
						firstFileByExtension.set(ext, fullPath);
					}
				}
			}
		}
	}

	walk(directory);

	return [...extensionCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.flatMap(([extension]) => {
			const filePath = firstFileByExtension.get(extension);
			return filePath ? [{ extension, filePath }] : [];
		});
}

export function inferSeedFileFromDirectory(directory: string): DirectorySeed | null {
	return inferSeedFilesByFrequency(directory)[0] ?? null;
}

export function inferExtensionFromDirectory(directory: string): string | null {
	return inferSeedFileFromDirectory(directory)?.extension ?? null;
}

export function findFirstFileWithExtensions(directory: string, extensions: readonly string[]): string | null {
	if (extensions.length === 0) return null;
	const wanted = new Set(extensions);
	let scanned = 0;
	let found: string | null = null;
	let fallback: string | null = null;

	function walk(dir: string): void {
		if (found !== null || scanned >= MAX_SCAN_ENTRIES) return;

		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			if (found !== null || scanned >= MAX_SCAN_ENTRIES) return;

			const fullPath = join(dir, entry);

			let stat: ReturnType<typeof lstatSync> | undefined;
			try {
				stat = lstatSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isSymbolicLink()) continue;
			scanned++;

			if (stat.isDirectory()) {
				if (!shouldSkipDirectory(entry)) {
					walk(fullPath);
				}
			} else if (stat.isFile()) {
				const ext = extname(fullPath);
				if (ext && wanted.has(ext)) {
					if (!isConfigLikeFile(entry)) {
						found = fullPath;
						return;
					}
					if (fallback === null) {
						fallback = fullPath;
					}
				}
			}
		}
	}

	walk(directory);
	return found ?? fallback;
}
