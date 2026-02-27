# Discode Test Improvement Plan

## 1. Test Execution Results Summary

**Run Date:** 2026-02-27
**Test Runner:** vitest v4.0.18
**Total Duration:** 9.89s

| Metric | Count |
|--------|-------|
| Test Files | 144 |
| Files Passed | 135 |
| Files Failed | 8 |
| Files Skipped | 1 |
| Total Tests | 2161 |
| Tests Passed | 2136 |
| Tests Failed | 24 |
| Tests Skipped | 1 |

### Failed Test Files

| # | File | Failures | Root Cause |
|---|------|----------|------------|
| 1 | `tests/bridge/hook-server-new-hooks.test.ts` | 4 | Bold markdown formatting mismatch + ECONNREFUSED |
| 2 | `tests/bridge/hook-server-permission-task.test.ts` | 2 | Bold markdown formatting mismatch |
| 3 | `tests/bridge/hook-server-thinking-thread-platform.test.ts` | 3 | Thinking delivery changed from thread to channel |
| 4 | `tests/bridge/container-send.test.ts` | 7 | Thinking/thread reply mechanism changed |
| 5 | `tests/bridge/hook-server-auto-pending.test.ts` | 4 | Tool activity thread reply mechanism changed |
| 6 | `tests/bridge/error-recovery-resilience-hooks.test.ts` | 2 | Tool activity thread reply + PendingMessageTracker API |
| 7 | `tests/bridge/hook-server-idle-response-prompt.test.ts` | 1 | Thinking delivery changed from thread to channel |
| 8 | `tests/bridge/hook-server-new-hooks.test.ts` | 1 | Server port collision (ECONNREFUSED) |

---

## 2. Coverage Status

`@vitest/coverage-v8` is not installed as a dependency. Coverage metrics are unavailable.

**Action required:** Install `@vitest/coverage-v8` as a dev dependency to enable coverage reporting.

### Source Files Without Test Files (53 files)

Critical modules missing dedicated tests:

| Priority | Module | File | Reason |
|----------|--------|------|--------|
| HIGH | Hook idle response | `src/bridge/hook-idle-response.ts` | Core response delivery logic (splitting, thinking, files) |
| HIGH | Message buffer fallback | `src/bridge/message-buffer-fallback.ts` | Fallback delivery path |
| HIGH | Message router | `src/bridge/message-router.ts` | Routes messages between platforms |
| HIGH | Container file operations | `src/container/file-operations.ts` | File injection into containers |
| HIGH | Container MCP bridge | `src/container/mcp-bridge-injector.ts` | MCP bridge injection |
| HIGH | Docker socket | `src/container/docker-socket.ts` | Docker communication layer |
| MEDIUM | Channel service | `src/app/channel-service.ts` | Channel mapping management |
| MEDIUM | Daemon service | `src/app/daemon-service.ts` | Daemon lifecycle |
| MEDIUM | Discord handlers | `src/discord/handlers.ts` | Discord event handlers |
| MEDIUM | Capture/VT renderer | `src/capture/vt-renderer.ts` | Terminal rendering |
| MEDIUM | Environment | `src/infra/environment.ts` | Environment detection |
| MEDIUM | Shell | `src/infra/shell.ts` | Shell command execution |
| MEDIUM | Storage | `src/infra/storage.ts` | State persistence |
| LOW | CLI commands (12 files) | `src/cli/commands/*.ts` | CLI user commands |
| LOW | Agent adapters (5 files) | `src/agents/*/index.ts` | Agent type wrappers |
| LOW | Type definitions (3 files) | `src/types/*.ts` | Pure type definitions |

---

## 3. Failed Test Analysis

### Category A: Bold Markdown Formatting Mismatch (9 failures)

**Root Cause:** Source code in `src/bridge/hook-event-handlers.ts` was refactored to wrap key phrases in Slack/Discord bold markers (`*...*`), but the test expectations were not updated.

**Affected tests:**

#### `tests/bridge/hook-server-new-hooks.test.ts`

1. **`tool.failure without error sends minimal message`**
   - Test expects: `'⚠️ Edit failed'`
   - Actual output: `'⚠️ *Edit failed*'`
   - Source: `handleToolFailure()` at line 268 sends `` `⚠️ *${toolName} failed*${errorSuffix}` ``

2. **`handles teammate.idle event`**
   - Test expects: `'💤 [agent-2] idle'`
   - Actual output: `'💤 *[agent-2]* idle'`
   - Source: `handleTeammateIdle()` at line 277 sends `` `💤 *[${teammateName}]* idle${teamSuffix}` ``

3. **`teammate.idle includes team name when provided`**
   - Test expects: `'💤 [agent-3] idle (backend-team)'`
   - Actual output: `'💤 *[agent-3]* idle (backend-team)'`
   - Same source as above.

4. **`teammate.idle with missing teammateName does not send`**
   - Fails with `ECONNREFUSED` — this is a port collision issue (server not started in time or port conflict)

#### `tests/bridge/hook-server-permission-task.test.ts`

5. **`sends permission message without toolInput when empty`**
   - Test expects: `'🔐 Permission needed: \`Bash\`'`
   - Actual output: `'🔐 *Permission needed:* \`Bash\`'`
   - Source: `handlePermissionRequest()` at line 237 sends `` `🔐 *Permission needed:* \`${toolName}\`${inputSuffix}` ``

6. **`sends message without subject when missing`**
   - Test expects: `'✅ Task completed'`
   - Actual output: `'✅ *Task completed*'`
   - Source: `handleTaskCompleted()` at line 245 sends `'✅ *Task completed*'`

**Fix:** Update all test expectations to include `*bold*` markers matching the current source code.

---

### Category B: Thinking Delivery Changed from Thread to Channel (4 failures)

**Root Cause:** The `handleSessionIdle` function (line 221) calls `postThinkingToChannel()` which uses `splitAndSendToChannel()` — this sends thinking as **channel messages**, not thread replies. Tests were written expecting `replyInThread` calls which no longer happen.

**Affected tests:**

#### `tests/bridge/hook-server-thinking-thread-platform.test.ts`

7. **`splits long thinking into multiple thread replies`**
   - Test expects: `mockMessaging.replyInThread.mock.calls.length >= 2`
   - Actual: `replyInThread` is never called (count = 0)
   - Thinking goes through `splitAndSendToChannel` → `sendToChannel`

8. **`uses Discord splitting for discord platform thinking`**
   - Same issue as above.

9. **`sends thinking and main response to correct channels independently`**
   - Test expects `replyInThread` to be called; it is not.

#### `tests/bridge/hook-server-idle-response-prompt.test.ts`

10. **`sends thinking + text + promptText in correct order`**
    - Test expects `replyInThread` for thinking, but thinking goes to `sendToChannel`.

#### `tests/bridge/container-send.test.ts` (7 failures in thinking section)

11-17. All tests in `'/opencode-event thinking from container agent'` describe block:
   - `posts thinking as thread reply` — expects `replyInThread`, gets `sendToChannel`
   - `wraps thinking in code block` — same issue
   - `routes thinking thread reply to correct instance channel` — same issue
   - `sends thinking + promptText + text` — same issue
   - `posts tool.activity from container instance as thread reply` — expects `replyInThreadWithId` direct call
   - `routes tool.activity to correct instance channel` — same issue
   - `posts intermediateText from container instance as thread reply` — intermediate text now also goes to channel via `postIntermediateTextToChannel`

**Fix:** Update tests to expect `sendToChannel` calls for thinking/intermediateText instead of `replyInThread`. The thinking text format is `` `:brain: *Reasoning*\n\`\`\`\n${text}\n\`\`\`` ``.

---

### Category C: Tool Activity Thread Reply Mechanism Changed (4 failures)

**Root Cause:** `handleToolActivity` (line 168-195) now uses `streamingUpdater.append()` to accumulate activity lines. It no longer directly calls `replyInThreadWithId` on the messaging client. The streaming updater handles batched updates. Tests that mock messaging directly and expect `replyInThreadWithId` calls fail.

**Affected tests:**

#### `tests/bridge/hook-server-auto-pending.test.ts`

18. **`auto-creates pending entry for tmux-initiated tool.activity`**
    - Expects `replyInThreadWithId` to be called directly; it is not.

19. **`tool.activity posts as thread reply`**
    - Same: expects `replyInThreadWithId`, actual path goes through `streamingUpdater`.

20. **`auto-pending creates pending and posts tool activity as thread reply`**
    - Same issue.

21. **`full lifecycle: tool activities replaced in thread → finalize`**
    - Complex lifecycle test; expects `replyInThreadWithId` called once, then `updateMessage`, then finalize. The actual code path has changed.

#### `tests/bridge/error-recovery-resilience-hooks.test.ts`

22. **`tool.activity continues to work after markCompleted clears pending entry`**
    - Uses real `PendingMessageTracker` with mock messaging that expects `replyInThreadWithId`.
    - The tracker's `ensurePending` sends `sendToChannelWithId` which the mock does provide, but the actual tool.activity code path changed.

23. **`tmux-initiated full lifecycle: ensurePending → tool.activity → session.idle`**
    - Complex lifecycle test expecting direct `replyInThreadWithId` + `replyInThread` calls.

**Fix:** Update tests to verify `streamingUpdater.append()` calls instead of direct `replyInThreadWithId` calls. For tests using the shared helpers from `hook-server-helpers.ts`, the `createMockStreamingUpdater` already exists.

---

## 4. Test Quality Review

### Strengths

1. **Good test isolation pattern**: Most hook-server tests use a shared `hook-server-helpers.ts` module with consistent mock factories (`createMockMessaging`, `createMockPendingTracker`, `createMockStateManager`, `createMockStreamingUpdater`).

2. **Real HTTP server tests**: Tests spin up actual `BridgeHookServer` instances on random ports, making them closer to integration tests than pure unit tests.

3. **Comprehensive edge case coverage for bridge module**: The bridge directory has 50+ test files covering event pipeline, auto-pending, streaming, error recovery, multi-instance routing, etc.

4. **Good describe/it naming**: Most tests follow clear BDD naming with descriptive test names.

### Issues Found

1. **Inconsistent mock patterns across test files**:
   - `container-send.test.ts` defines its own `createMockMessaging` (missing `replyInThread`, `replyInThreadWithId`, `updateMessage`)
   - `error-recovery-resilience-hooks.test.ts` defines its own `createMockMessaging` (includes `replyInThreadWithId`, `updateMessage` but different shape)
   - `hook-server-helpers.ts` has the canonical mock with all methods
   - **Recommendation**: Migrate all test files to use the shared `hook-server-helpers.ts` mocks.

2. **Port collision risk**: Tests use `port = 19000 + Math.floor(Math.random() * 1000)` which can collide when tests run in parallel. One failure (`teammate.idle with missing teammateName does not send`) was caused by ECONNREFUSED, likely a port collision.
   - **Recommendation**: Use `port = 0` and let the OS assign a free port, or use a deterministic port derivation.

3. **Timing-sensitive tests**: All tests use `await new Promise((r) => setTimeout(r, 50))` to wait for the server to start listening. This is fragile.
   - **Recommendation**: Add a `ready()` promise to `BridgeHookServer` that resolves when `server.listen()` callback fires.

4. **Missing `streamingUpdater` in some test files**: `container-send.test.ts` and `error-recovery-resilience-hooks.test.ts` create inline streaming updater stubs `{ canStream: vi.fn(), start: vi.fn(), ... }` instead of using the shared factory.
   - **Recommendation**: Use `createMockStreamingUpdater()` from `hook-server-helpers.ts`.

5. **Test file proliferation**: The bridge module has been split into very granular test files (50+). While this aids isolation, it increases maintenance overhead and makes it harder to understand coverage holistically.
   - **Recommendation**: Consider consolidating related test files (e.g., merge `hook-server-thinking.test.ts`, `hook-server-thinking-thread.test.ts`, `hook-server-thinking-thread-platform.test.ts` into one file).

---

## 5. Improvement Plan (Prioritized)

### P0: Fix Failing Tests (24 failures)

| # | Action | Files to Modify | Effort |
|---|--------|----------------|--------|
| 1 | Update bold markdown expectations in test assertions | `hook-server-new-hooks.test.ts`, `hook-server-permission-task.test.ts` | Small |
| 2 | Update thinking delivery tests to expect `sendToChannel` instead of `replyInThread` | `hook-server-thinking-thread-platform.test.ts`, `hook-server-idle-response-prompt.test.ts` | Medium |
| 3 | Update container thinking tests for channel-based delivery | `container-send.test.ts` (7 tests in thinking section) | Medium |
| 4 | Update tool activity tests to verify `streamingUpdater.append` instead of `replyInThreadWithId` | `hook-server-auto-pending.test.ts`, `error-recovery-resilience-hooks.test.ts` | Medium |
| 5 | Fix ECONNREFUSED in `teammate.idle with missing teammateName` (likely port collision) | `hook-server-new-hooks.test.ts` | Small |

### P1: Install Coverage Tooling

| # | Action | Effort |
|---|--------|--------|
| 6 | Install `@vitest/coverage-v8` as dev dependency | Small |
| 7 | Add coverage thresholds to `vitest.config.ts` | Small |
| 8 | Add `npm run test:coverage` script to `package.json` | Small |

### P2: Add Tests for Critical Untested Modules

| # | Module | File | Why Critical |
|---|--------|------|-------------|
| 9 | Hook idle response | `src/bridge/hook-idle-response.ts` | Core response delivery (splitting, thinking wrapping, file path validation) — indirectly tested but no dedicated unit tests |
| 10 | Container file operations | `src/container/file-operations.ts` | File injection into containers |
| 11 | Container MCP bridge injector | `src/container/mcp-bridge-injector.ts` | MCP bridge lifecycle |
| 12 | Docker socket | `src/container/docker-socket.ts` | Docker communication |
| 13 | Message buffer fallback | `src/bridge/message-buffer-fallback.ts` | Fallback delivery path |
| 14 | Channel service | `src/app/channel-service.ts` | Channel mapping CRUD |
| 15 | Daemon service | `src/app/daemon-service.ts` | Daemon process lifecycle |

### P3: Standardize Test Patterns

| # | Action | Effort |
|---|--------|--------|
| 16 | Migrate `container-send.test.ts` to use shared `hook-server-helpers.ts` mocks | Medium |
| 17 | Migrate `error-recovery-resilience-hooks.test.ts` to use shared mocks | Medium |
| 18 | Add `ready()` promise to `BridgeHookServer` to eliminate `setTimeout(r, 50)` pattern | Medium |
| 19 | Replace random port assignment with OS-assigned ports (`port: 0`) | Medium |
| 20 | Consider consolidating granular bridge test files (50+ files) into logical groups | Large |

### P4: Integration / E2E Test Gaps

| # | Area | Description |
|---|------|-------------|
| 21 | Full event lifecycle | End-to-end test: platform message → hook server → event pipeline → messaging client → platform response. Currently tested in pieces but no single flow test. |
| 22 | Container mode lifecycle | Container creation → agent injection → message routing → response delivery. Currently tested in isolation per module. |
| 23 | Multi-platform parity | Tests predominantly use `slack` as default platform. Add systematic Discord platform variant tests. |
| 24 | Daemon startup/shutdown | No tests for the daemon process lifecycle (`src/daemon.ts`, `src/daemon-entry.ts`). |

---

## Summary

The test suite is in good shape overall (99%+ pass rate when tests are aligned with source). The 24 failures are all caused by **source code changes not reflected in test expectations** — specifically:
1. Bold markdown formatting added to event handler messages
2. Thinking delivery moved from thread replies to channel messages
3. Tool activity delivery moved to streaming updater

Fixing these requires updating test assertions only (no source code changes needed). The test infrastructure (shared helpers, real HTTP servers, mock factories) is well-designed.

The main areas for improvement are:
- **Install coverage tooling** to get quantitative coverage data
- **Add tests for `hook-idle-response.ts`** — the most critical untested module
- **Standardize mock patterns** across all bridge test files
- **Reduce port collision risk** with OS-assigned ports
