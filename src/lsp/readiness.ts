// Server-readiness: many language servers accept `initialized` before their
// project/index is actually loaded, so the first navigation request can fail
// or return nothing. The failure mode is per-server. Empirically observed
// (cold `workspace/symbol` against a large real project):
//
//   server                       cold behavior                         handled by
//   ---------------------------  ------------------------------------  --------------------------
//   ty                           request BLOCKS until indexed, ok      nothing (it waits)
//   pyright / basedpyright       returns empty, no error               nothing (soft; can't detect)
//   pyrefly                      error -32800 RequestCancelled         standard LSP code (below)
//   typescript-language-server   error code 1 "No Project." until a    open the caller's filePath
//   / vtsls                      document is opened (project is lazy)  before the call + matcher
//
// Two extensible signals fall out of that:
//   1. Standard LSP "retry" codes (-32801 ContentModified / -32800
//      RequestCancelled) - spec-defined, safe to treat as not-ready for ANY
//      server.
//   2. A per-server descriptor for the non-spec cases (typescript's project
//      laziness): bootstrap by opening the caller's file before the request
//      and recognize the bespoke "still loading" error.
//
// Backwards compatibility: a server with no descriptor and no standard code
// behaves exactly as before (no extra didOpen, no extra retries).

const LSP_CONTENT_MODIFIED = -32801;
const LSP_REQUEST_CANCELLED = -32800;

export interface ResponseLike {
	code?: number | undefined;
	message?: string | undefined;
}

export interface ServerReadiness {
	/**
	 * Open the caller-supplied filePath before the request. Required for
	 * servers (typescript) whose project/program is created lazily on first
	 * `textDocument/didOpen` - without it, `workspace/symbol` (which never
	 * opens a file on its own) has no project to resolve against.
	 */
	requiresOpenFileToInitProject?: boolean;
	/**
	 * Recognize a server-specific (beyond the LSP spec codes) error that means
	 * "still loading, retry". Receives the response error's code + message.
	 */
	notReady?: (err: ResponseLike) => boolean;
}

// tsserver emits the literal substring "No Project." (capitalized, with the
// period). Anchor on that exact form to avoid matching unrelated messages that
// happen to contain "no project".
const noProjectMatcher = (err: ResponseLike): boolean => (err.message ?? "").includes("No Project.");

export const SERVER_READINESS: Record<string, ServerReadiness> = {
	// typescript-language-server: cold `workspace/symbol` throws tsserver error
	// code 1 with message "No Project." until a document is opened (which
	// creates the configured/inferred project). Verified against
	// typescript@6.0.2 on a ~12k-file project. vtsls wraps the same tsserver.
	typescript: { requiresOpenFileToInitProject: true, notReady: noProjectMatcher },
	vtsls: { requiresOpenFileToInitProject: true, notReady: noProjectMatcher },
};

function readCode(err: unknown): number | undefined {
	if (err && typeof err === "object" && "code" in err && typeof err.code === "number") {
		return err.code;
	}
	return undefined;
}

function readMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
		return err.message;
	}
	return "";
}

/** Spec-defined "retry" codes - safe to treat as not-ready for any server. */
export function isStandardNotReadyError(err: unknown): boolean {
	const code = readCode(err);
	return code === LSP_CONTENT_MODIFIED || code === LSP_REQUEST_CANCELLED;
}

/** True when `err` from `serverId` means "still loading, retry" (standard code
 * or the server's own matcher). Unknown servers: standard codes only. */
export function isNotReadyError(err: unknown, serverId: string): boolean {
	if (isStandardNotReadyError(err)) return true;
	const matcher = SERVER_READINESS[serverId]?.notReady;
	return matcher ? matcher({ code: readCode(err), message: readMessage(err) }) : false;
}

export function getServerReadiness(serverId: string): ServerReadiness | undefined {
	return SERVER_READINESS[serverId];
}
