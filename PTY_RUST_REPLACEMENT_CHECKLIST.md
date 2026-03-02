# PTY Rust Replacement Checklists (Zellij-Structure Aligned)

Goal: fully replace `pty-ts` with `pty-rust`, align runtime internals with Zellij-style boundaries (`PTY bus -> terminal model -> screen/renderer -> IPC`), and provide a full migration track from TypeScript daemon to Rust daemon.

## Target Architecture Checklist (Zellij-style)

- [ ] sidecar has explicit modules: `pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, `rpc`
- [ ] PTY read/write lives only in `pty_bus` (no direct PTY access from RPC handlers)
- [ ] ANSI/VT parse and state updates live in `terminal_pane` + `grid_scrollback`
- [ ] `screen` owns viewport/frame assembly and cursor metadata
- [ ] `renderer` produces deterministic `TerminalStyledFrame` and patch diffs
- [ ] `session_manager` owns window lifecycle, status, env, and process metadata
- [ ] RPC layer is transport only (decode -> command -> encode), no business logic leakage
- [ ] sidecar exposes a stable command/event contract independent of transport details

## Final Product State Checklist

- [ ] `runtimeMode` surface is `tmux | pty-rust`
- [ ] legacy `pty` and `pty-ts` inputs normalize to `pty-rust`
- [ ] `PtyRustRuntime` contains no TS fallback branch
- [ ] Rust sidecar is the only PTY engine for PTY runtime mode
- [ ] daemon control plane is Rust in production (or TypeScript compatibility shim only)
- [ ] docs/onboarding remove PoC and experimental wording

## Phase 0 - Architecture Contract and Gap Audit

- [x] publish architecture map from current PoC to target Zellij-like modules (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] define ownership rules for each module boundary (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] list all current RPC methods and map each to command handler modules (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] define migration policy: no feature additions outside replacement scope (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)
- [x] create risk list: VT fidelity, stream latency, platform parity, lifecycle races (`docs/PTY_RUST_ARCHITECTURE_CONTRACT.md`)

Exit criteria:

- [ ] architecture contract document approved
- [ ] module ownership and coding rules agreed

## Phase 1 - Sidecar Skeleton Refactor (No Behavior Change)

- [x] create module tree in `sidecar/pty-rust/src/` (`pty_bus`, `terminal_pane`, `grid_scrollback`, `screen`, `renderer`, `session_manager`, `rpc`)
- [x] move window/session state out of `main.rs` into `session_manager` (state structs/registry + locking/window access helpers moved)
- [x] move PTY spawn/read/write/resize into `pty_bus` (`spawn_window_process`, `write_input`, `resize_window`, `stop_window`, `dispose_window`)
- [x] move VT-lite parser logic into `terminal_pane` + `grid_scrollback` (kept `vt_lite` as compatibility adapter)
- [x] keep existing RPC methods working via adapters (`vt_lite` compatibility adapter -> `terminal_pane::build_styled_frame`)
- [x] add integration tests to prove behavior equivalence after moves (`unix_main` RPC/session/window integration tests)

Exit criteria:

- [x] `main.rs` is thin bootstrap + transport wiring only
- [x] refactor passes all pre-existing sidecar/runtime tests

## Phase 2 - Runtime Transport and Execution Model Hardening

- [x] replace request-per-process client pattern with persistent RPC connection model (persistent `client` bridge + line-delimited RPC over single socket connection)
- [x] introduce request ids, timeouts, and explicit error codes
- [x] implement sidecar heartbeat/health method
- [x] add controlled shutdown and socket/pipe cleanup guarantees
- [x] add observability: per-method latency/error counters and sidecar startup metrics

Exit criteria:

- [x] no per-request `spawnSync` in steady state path (persistent bridge path; one-shot request fallback retained for compatibility)
- [ ] request tail latency improves versus PoC baseline

## Phase 3 - Terminal Engine Fidelity (Zellij-like terminal pane behavior)

- [ ] implement robust parser state machine for split/incomplete sequences
- [ ] harden cursor movement, wrapping, scroll region, save/restore, reverse index
- [ ] harden alt-screen enter/leave transitions and cursor visibility behavior
- [ ] implement wide/combining char width correctness in grid writes
- [ ] define and implement query-response policy for supported terminal queries
- [ ] build regression fixtures from real agent outputs

Exit criteria:

- [ ] fixture pass rate reaches target threshold
- [ ] no known blocker in interactive agent CLIs

## Phase 4 - Screen and Renderer Separation

- [ ] `screen` module owns frame composition from pane/grid state
- [ ] `renderer` owns style segment compaction and patch-diff calculation
- [ ] define deterministic frame/patch emission rules for unchanged/changed states
- [ ] add backpressure/coalescing policy for burst output
- [ ] validate cursor/frame consistency under rapid resize

Exit criteria:

- [ ] stream tests pass under burst + resize stress
- [ ] frame generation cost is within budget

## Phase 5 - Session and Window Lifecycle Reliability

- [ ] implement explicit window lifecycle state transitions (`idle/starting/running/exited/error`)
- [ ] guarantee idempotent start/stop and clear error behavior on repeated calls
- [ ] ensure process exit detection updates state and emits expected events
- [ ] ensure environment propagation rules are deterministic per session/window
- [ ] add lifecycle race tests (start-stop, rapid resize, dispose during I/O)

Exit criteria:

- [ ] lifecycle tests pass with race-focused stress runs
- [ ] no leaked PTY children or stale sockets in test runs

## Phase 6 - Cross-Platform Runtime Completion

- [ ] implement Windows transport parity (named pipe)
- [ ] verify PTY backend parity behavior on macOS/Linux/Windows
- [ ] provide sidecar binaries for all supported platforms
- [ ] validate binary discovery/override path behavior per OS
- [ ] run CI matrix with e2e runtime suites

Exit criteria:

- [ ] `pty-rust` is production-usable across supported OSes

## Phase 7 - Node Integration Cutover

- [ ] update runtime factory/mode resolution to make `pty-rust` primary PTY backend
- [ ] remove TS fallback code from `src/runtime/pty-rust-runtime.ts`
- [ ] keep TypeScript daemon API surfaces unchanged for callers
- [ ] normalize config/CLI inputs: `pty`/`pty-ts` -> `pty-rust`
- [ ] update CLI/TUI labels and help text
- [ ] update architecture and runtime docs to new structure

Exit criteria:

- [ ] upgraded and fresh installs run PTY mode through sidecar only

## Phase 8 - Canary Rollout with SLO Gates

- [ ] define SLOs: crash rate, frame mismatch rate, input RTT, memory/CPU ceilings
- [ ] ship canary release with enhanced telemetry
- [ ] rollout progression: 10% -> 50% -> 100% only after gate pass
- [ ] keep emergency switch only between `tmux` and `pty-rust`
- [ ] monitor one full release cycle post-100%

Exit criteria:

- [ ] SLOs are stable for full rollout window

## Phase 9 - Remove `pty-ts` and Cleanup

- [ ] remove remaining `pty-ts` implementation and references from runtime code
- [ ] remove/update tests that depend on old TS runtime internals
- [ ] remove `pty-ts` mentions from CLI/docs/help/onboarding
- [ ] remove obsolete compatibility shims no longer needed
- [ ] run full test + e2e suites and fix final regressions

Exit criteria:

- [ ] no production/runtime code path references `pty-ts`
- [ ] project docs and tests reflect `tmux | pty-rust` model

## Track B - Daemon Migration (TypeScript -> Rust)

This track can run in parallel after runtime contracts are stable enough (recommended start: after Phase 4 or later).

### B0 - Daemon Contract Freeze

- [ ] freeze HTTP control-plane API contract and payload schema
- [ ] freeze runtime stream protocol contract and handshake behavior
- [ ] freeze hook ingestion contract (`/opencode-event`, `/send-files`, `/reload`)
- [ ] document exact compatibility behavior for config/state loading
- [ ] define compatibility policy for telemetry and logging fields

Exit criteria:

- [ ] contract test suite exists and runs against current TS daemon

### B1 - Rust Daemon Workspace and Process Model

- [ ] create Rust daemon workspace/crate (eg. `daemon-rs/`)
- [ ] implement singleton process model (pid file, lock, lifecycle commands)
- [ ] implement daemon log file strategy equivalent to current behavior
- [ ] implement startup/shutdown/status command compatibility surface
- [ ] preserve macOS sleep-prevention behavior where required

Exit criteria:

- [ ] Rust daemon can boot and stay healthy as a standalone process

### B2 - Config and State Compatibility Layer

- [ ] implement Rust config loader compatible with `~/.discode/config.json`
- [ ] implement Rust state loader compatible with `~/.discode/state.json`
- [ ] implement legacy normalization behavior currently done in TS
- [ ] add roundtrip and migration tests for old/new state variants
- [ ] ensure no data loss in read/modify/write cycles

Exit criteria:

- [ ] fixture set of real user state/config files passes compatibility tests

### B3 - Hook Server and Messaging Bridge in Rust

- [ ] implement loopback HTTP server and endpoint parity
- [ ] port webhook/event ingestion path and validation behavior
- [ ] port file-send path validation and limits
- [ ] preserve pending message lifecycle behavior
- [ ] add integration tests for success/error edge cases

Exit criteria:

- [ ] endpoint contract tests pass against Rust daemon implementation

### B4 - Runtime Control and Stream Planes in Rust

- [ ] implement `/runtime/*` control endpoints with parity
- [ ] implement stream socket server with protocol parity
- [ ] wire runtime adapter to `pty-rust` backend only for PTY mode
- [ ] preserve focus/input/resize/buffer/list/stop semantics
- [ ] add stress tests for concurrent stream clients and rapid resize/input

Exit criteria:

- [ ] control + stream e2e parity tests pass against TS baseline

### B5 - Integrations and Router Port

- [ ] port project bootstrap/mapping rebuild behavior
- [ ] port message router logic and attachment injection behavior
- [ ] port channel/project resolution rules and edge case handling
- [ ] port submit timing behavior by agent type
- [ ] add integration tests with mocked messaging providers

Exit criteria:

- [ ] routing and delivery parity validated on integration suite

### B6 - CLI Transition Strategy

- [ ] keep existing CLI UX stable while switching backend daemon implementation
- [ ] add feature flag to select TS vs Rust daemon during transition
- [ ] make `discode daemon start|stop|status|restart` backend-agnostic
- [ ] add fallback strategy: auto-revert to TS daemon on critical Rust daemon boot failure
- [ ] update install/build pipeline to package Rust daemon binary

Exit criteria:

- [ ] users can switch daemon backend without changing CLI workflows

### B7 - Canary and Default Flip

- [ ] define daemon-specific SLOs (crash-free uptime, hook latency, runtime API latency)
- [ ] ship staged canary with Rust daemon enabled by flag
- [ ] promote to default after gate pass (10% -> 50% -> 100%)
- [ ] keep emergency rollback switch to TS daemon for one release cycle
- [ ] monitor production telemetry and incident rate over full cycle

Exit criteria:

- [ ] Rust daemon is stable as default in production

### B8 - Retire TypeScript Daemon Paths

- [ ] remove TS daemon entrypoint from production path (`src/index.ts`, `src/daemon-entry.ts` runtime usage)
- [ ] remove TS-only daemon modules no longer used
- [ ] keep minimal compatibility stubs only if required for migration tooling
- [ ] update architecture docs and operational docs to Rust daemon model
- [ ] run full regression + release checklist before final removal

Exit criteria:

- [ ] TypeScript daemon is no longer required for production runtime

## Repository File Checklist (expected touch points)

- [ ] `sidecar/pty-rust/src/main.rs` (bootstrap/transport only)
- [ ] `sidecar/pty-rust/src/vt_lite.rs` (to be split/migrated)
- [ ] `sidecar/pty-rust/src/pty_bus.rs` (new)
- [ ] `sidecar/pty-rust/src/terminal_pane.rs` (new)
- [ ] `sidecar/pty-rust/src/grid_scrollback.rs` (new)
- [ ] `sidecar/pty-rust/src/screen.rs` (new)
- [ ] `sidecar/pty-rust/src/renderer.rs` (new)
- [ ] `sidecar/pty-rust/src/session_manager.rs` (new)
- [ ] `sidecar/pty-rust/src/rpc.rs` (new)
- [ ] `src/runtime/rust-sidecar-client.ts`
- [ ] `src/runtime/pty-rust-runtime.ts`
- [ ] `src/runtime/factory.ts`
- [ ] `src/runtime/mode.ts`
- [ ] `src/types/index.ts`
- [ ] `bin/discode.ts`
- [ ] `bin/onboard-tui.tsx`
- [ ] `src/cli/commands/tui-config-commands.ts`
- [ ] `ARCHITECTURE.md`
- [ ] `docs/PTY_RUST_SIDECAR_POC.md`
- [ ] `src/index.ts` (migration/replacement path)
- [ ] `src/daemon-entry.ts` (migration/replacement path)
- [ ] `src/bridge/**` (porting parity review)
- [ ] `src/runtime/control-plane.ts` (parity review)
- [ ] `src/runtime/stream-server.ts` (parity review)
- [ ] `src/state/**` (compatibility parity review)
- [ ] `src/config/**` (compatibility parity review)
- [ ] `daemon-rs/` (new Rust daemon workspace)
- [ ] `docs/DAEMON_RUST_MIGRATION.md` (new)

## Validation Gates (must pass before final merge)

- [ ] functional: runtime control behaviors unchanged (`ensure/focus/input/stop/list/buffer`)
- [ ] functional: TUI rendering/input workflows unchanged for supported agents
- [ ] reliability: no TS fallback dependency in PTY runtime mode
- [ ] compatibility: all supported OS e2e checks pass
- [ ] performance: startup/input/frame metrics meet defined budgets
- [ ] daemon parity: hook/control/stream API contract tests pass on Rust daemon
- [ ] migration safety: rollback from Rust daemon to TS daemon works during transition window

## Operational Checklist During Implementation

- [ ] after runtime code changes, restart daemon:
  - [ ] `discode-src daemon stop`
  - [ ] `discode-src daemon start`
  - [ ] `discode-src daemon status`
- [ ] document user-visible migration notes in release notes/changelog
- [ ] confirm release checklist items in `AGENTS.md` when shipping
