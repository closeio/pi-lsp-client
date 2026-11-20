export const DEFAULT_MAX_REFERENCES = 200;
export const DEFAULT_MAX_SYMBOLS = 200;
export const DEFAULT_MAX_DIAGNOSTICS = 200;
export const DEFAULT_MAX_DIRECTORY_FILES = 50;
export const DEFAULT_MAX_DEFINITION_LINES = 50;
export const DEFAULT_FALLBACK_DEFINITION_LINES = 20;

// Default timeouts — override per-server via `.pi/lsp-client.json` or
// `~/.pi/lsp-client.json` (`requestTimeoutMs` / `initTimeoutMs` fields), since
// some servers (e.g. kotlin-language-server on a multi-module Gradle project)
// take far longer than others to answer `initialize`.
export const REQUEST_TIMEOUT_MS = 15_000;
export const INIT_TIMEOUT_MS = 60_000;
// After the initial didOpen on a server that loads its project lazily (e.g.
// typescript-language-server), wait up to this long for a `$/progress` token or
// `textDocument/publishDiagnostics` notification before assuming no background
// project load is coming. Large monorepos can take >2s before tsserver emits
// `projectLoadingStart`.
export const PROJECT_LOAD_GRACE_MS = 5_000;
// Per-call self-heal: a tool request that hits a recognized "still loading"
// signal is retried for up to this long before surfacing as initializing.
export const NOT_READY_RETRY_TIMEOUT_MS = 10_000;
export const NOT_READY_RETRY_INTERVAL_MS = 500;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const REAPER_INTERVAL_MS = 60_000;
export const STOP_HARD_KILL_TIMEOUT_MS = 5_000;
export const STOP_SIGKILL_GRACE_MS = 1_000;
