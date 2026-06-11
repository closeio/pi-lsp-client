export const DEFAULT_MAX_REFERENCES = 200;
export const DEFAULT_MAX_SYMBOLS = 200;
export const DEFAULT_MAX_DIAGNOSTICS = 200;
export const DEFAULT_MAX_DIRECTORY_FILES = 50;

export const REQUEST_TIMEOUT_MS = 15_000;
export const INIT_TIMEOUT_MS = 60_000;
// Per-call self-heal: a tool request that hits a recognized "still loading"
// signal is retried for up to this long before surfacing as initializing.
export const NOT_READY_RETRY_TIMEOUT_MS = 10_000;
export const NOT_READY_RETRY_INTERVAL_MS = 500;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const REAPER_INTERVAL_MS = 60_000;
export const STOP_HARD_KILL_TIMEOUT_MS = 5_000;
export const STOP_SIGKILL_GRACE_MS = 1_000;
