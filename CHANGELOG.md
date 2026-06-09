# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Spawned LSP children no longer keep the parent's Node event loop alive.
  `spawnProcess` now calls `proc.unref()` and `unref()` on each stdio pipe.
  Without this, an LSP client owned by a fan-out sub-agent session (whose
  `session_shutdown` event never fires under the current pi SDK) would
  prevent pi from exiting after its main work was done, because the LSP
  child's stdio pipes registered as active handles on the loop.

### Changed

- **Breaking (internal):** the module-level `LspManager` singleton is gone.
  Each pi session now owns its own `LspManager`, resolved via
  `getManagerForSession(ctx.sessionManager)` from the new
  `manager-registry.js` module. `withLspClient` requires the manager to be
  passed explicitly via `options.manager` (previously fell back to a
  process-wide singleton). This eliminates a class of cross-session bugs
  where one session's `session_shutdown` could `stopAll()` LSP servers
  another concurrent sub-agent session was still using. The per-manager
  refCount, idle reaper, init timeout, and synchronous `process.on("exit")`
  killSync handler all continue to apply, but at session scope. Disposal
  on `session_shutdown` is the one and only caller-initiated teardown path;
  the exit handler remains as belt-and-suspenders for crashes.

### Added

- Initial release porting omo's LSP tool stack as a pi-coding-agent extension.
- Six tools: `lsp_diagnostics`, `lsp_goto_definition`, `lsp_find_references`,
  `lsp_symbols`, `lsp_prepare_rename`, `lsp_rename`.
- Per-session `LspManager` with refCount-based lifecycle, idle cleanup
  (5 minutes), init reaping (60 seconds), and abort-aware acquisition.
- Typed crash boundary: `LspConnectionClosedError` and
  `LspProcessExitedError` in `errors.ts`. The wrapper retries idempotent read
  tools exactly once on a typed dead-connection error; mutating tools are
  never retried.
- Built-in registry of 40+ language servers with per-server install hints
  ported verbatim from omo, plus an `AUTO_INSTALLABLE_SERVERS` whitelist that
  drives `/lsp install <id>` for safe automatic installation.
- Custom user config: `.pi/lsp-client.json` (project) and
  `~/.pi/lsp-client.json` (user) merge with project taking priority over
  user, both taking priority over the builtin registry.
- Three commands: `/lsp` (interactive inspector via `ctx.ui.custom`),
  `/lsp install <id>`, `/lsp warmup <id>`.
- Custom TUI rendering for all six tools, with bespoke expanded views for
  diagnostics, references, symbols, and rename, plus compact `Text`
  renderers for goto-definition and prepare-rename.
- Status footer (`ctx.ui.setStatus("pi-lsp", ...)`) showing alive vs
  initializing server counts, updated on `session_start` and `turn_end`,
  cleared on `session_shutdown`.
- `LspManager.getSnapshot()` API exposing per-client `{ root, serverId,
  refCount, pendingWaiters, lastUsedAt, isInitializing, alive, command }`
  for both the `/lsp` inspector and tests.
- TypeBox tool schemas with `StringEnum` for enum parameters so the tool
  surface stays compatible with Google's tool-calling API.
- `lsp_rename.executionMode = "sequential"` so workspace edits never race
  against pi's parallel tool execution or other mutating tools.
