# Discode UX Improvement Plan

> Analysis date: 2026-02-27
> Scope: Discord/Slack user-facing experience across 8 categories

---

## 1. Message Formatting

### Current State
- `src/capture/parser.ts` splits long messages with platform-aware limits: 1900 chars (Discord), 3900 chars (Slack)
- Code block fence continuity is handled correctly -- split chunks re-open/close fences
- Outermost code block wrapper is stripped before splitting (`stripOuterCodeblock`)
- `src/bridge/hook-idle-response.ts` calls `splitAndSendToChannel` which dispatches to `splitForDiscord` or `splitForSlack` based on `messaging.platform`

### Problems
- **P1: No markdown dialect conversion.** Raw markdown is sent as-is to Slack. Discord supports standard markdown, but Slack uses mrkdwn (e.g., `*bold*` instead of `**bold**`, `_italic_` instead of `*italic*`). Agent output formatted in standard markdown renders incorrectly on Slack.
- **P2: No message length feedback.** When content exceeds the split limit, it silently breaks into multiple messages. Users see fragmented output without knowing if more chunks are coming.
- **P1: Lines longer than maxLen are truncated.** In `splitMessages` line 89: `current = line.length > maxLen ? line.substring(0, maxLen) : line` -- long single lines (e.g., base64 data, minified JSON) are silently cut without any truncation indicator.

### Improvements
1. **Add markdown-to-mrkdwn converter for Slack** (`src/capture/parser.ts`)
   - Convert `**bold**` to `*bold*`, `*italic*` to `_italic_`, `[text](url)` to `<url|text>`
   - Apply conversion inside `splitForSlack` before splitting
   - Priority: **P1**

2. **Add truncation indicator for long lines**
   - When a line is cut, append `... (truncated)` to the truncated line
   - Priority: **P1**

3. **Add chunk numbering for multi-part messages**
   - When splitting produces 2+ chunks, prepend `(1/N)`, `(2/N)` etc. as a subtle suffix
   - Priority: **P2**

---

## 2. Progress Status (Reaction System)

### Current State
- `src/bridge/pending-message-tracker.ts` manages per-instance pending state with emoji reactions
- Flow: user sends message -> bot reacts with hourglass -> on completion reacts with checkmark (or X on error)
- Start message ("Processing...") is created lazily on first activity via `ensureStartMessage()`
- Recently completed entries are kept for 30s TTL to support late-arriving Stop hook events

### Problems
- **P2: No elapsed time on the pending reaction.** Users see hourglass but don't know how long the operation has been running.
- **P1: No distinction between "processing" and "waiting for user input".** When the agent asks a question (AskUserQuestion), the hourglass remains -- users may not realize they need to respond.
- **P2: Silent start message creation.** The "Processing..." message appears with no context about what is being processed.

### Improvements
1. **Replace hourglass with question mark when waiting for input**
   - In `handleSessionIdle` when `promptQuestions` or `promptText` exists, replace hourglass with a question emoji before posting the prompt
   - File: `src/bridge/hook-event-handlers.ts` lines 197-231
   - Priority: **P1**

2. **Add agent name to start message**
   - Change "Processing..." to "Processing... (claude)" or similar, using `agentType` from context
   - File: `src/bridge/pending-message-tracker.ts` line 91
   - Priority: **P2**

---

## 3. Streaming Updates

### Current State
- `src/bridge/streaming-message-updater.ts` debounces at 750ms (`DEBOUNCE_MS`), replacing the start message content with the latest activity text
- Finalize writes "Done" (with optional usage stats) when idle
- Flush promise prevents race conditions between debounced updates and finalize
- Thinking timer in `hook-event-handlers.ts` updates every 10s with elapsed time ("Thinking... (30s)")

### Problems
- **P2: Generic fallback text.** When `currentText` is empty, flush shows "Processing..." -- no information about what stage the agent is in.
- **P1: No tool name displayed during execution.** `handleToolActivity` receives tool activity text but doesn't indicate which tool is running (e.g., "Read", "Bash", "Edit").
- **P2: Thinking timer starts at 10s intervals.** The first elapsed time update doesn't appear until 10 seconds after thinking starts. This creates a gap where users see "Thinking..." without any time indication.

### Improvements
1. **Show tool names in streaming updates**
   - Parse structured tool activity text to extract tool name prefix (e.g., "Read: src/foo.ts" -> display as-is)
   - The current `ctx.text` from `tool.activity` events already contains descriptive text; ensure it's forwarded cleanly
   - File: `src/bridge/hook-event-handlers.ts` line 191
   - Priority: **P1**

2. **Reduce thinking timer initial interval**
   - Show first elapsed time at 5s instead of 10s
   - Change `THINKING_INTERVAL_MS` from 10000 to 5000
   - File: `src/bridge/hook-event-handlers.ts` line 46
   - Priority: **P2**

3. **Improve fallback text**
   - Change from "Processing..." to "Working..." or include last known activity
   - File: `src/bridge/streaming-message-updater.ts` line 110
   - Priority: **P2**

---

## 4. Error Handling UX

### Current State
- `handleSessionError` in `hook-event-handlers.ts` sends error message with warning emoji and recent activity context
- Recent activity lines (last 5) are appended under "최근 활동:" header
- `handleToolFailure` sends a brief tool name + error message
- Buffer fallback (`message-buffer-fallback.ts`) silently fails with console.warn on send errors

### Problems
- **P0: Korean-only error context label.** "최근 활동:" is hardcoded in Korean at line 63. Non-Korean users cannot understand this section.
- **P1: No actionable recovery guidance.** Error messages state what failed but don't suggest what users can do (retry, check logs, contact admin).
- **P2: Buffer fallback failures are invisible.** When `scheduleBufferFallback` fails to send captured text (line 168), the user sees nothing -- no error message, no indication that output was lost.
- **P1: Tool failure messages lack context.** `handleToolFailure` shows only tool name and error string, but not what the tool was trying to do.

### Improvements
1. **Internationalize error labels**
   - Change "최근 활동:" to "Recent activity:" (or support i18n)
   - File: `src/bridge/hook-event-handlers.ts` line 63
   - Priority: **P0**

2. **Add recovery suggestions to error messages**
   - Append a standard footer: "You can retry by sending your message again, or type `help` for assistance."
   - File: `src/bridge/hook-event-handlers.ts` lines 61-65
   - Priority: **P1**

3. **Notify users on buffer fallback failures**
   - When buffer fallback send fails, post a brief error message to the channel: "Could not deliver agent output. Check logs for details."
   - File: `src/bridge/message-buffer-fallback.ts` line 168-170
   - Priority: **P2**

4. **Include tool input preview in failure messages**
   - Show first 200 chars of tool input in `handleToolFailure` to give context
   - File: `src/bridge/hook-event-handlers.ts` lines 264-269
   - Priority: **P1**

---

## 5. Interactions (Buttons/Reactions)

### Current State
- **Discord approvals:** Emoji reactions (checkmark/X) with `awaitReactions` collector, 120s timeout, auto-deny on timeout
- **Discord questions:** Embed with buttons (Primary for first option, Secondary for rest), 300s timeout
- **Slack approvals:** Block Kit buttons (Allow/Deny), 120s timeout, auto-deny on timeout
- **Slack questions:** Block Kit buttons with optional field descriptions, 300s timeout
- Button selections are routed back to agents via `messageCallback`

### Problems
- **P1: Slack action handler leak.** In `SlackInteractions.sendApprovalRequest` (line 93-94), `this.app.action('approve_action', handler)` and `this.app.action('deny_action', handler)` register new handlers on every approval request but the `cleanup()` function only clears the timeout -- old handlers accumulate. Same issue in `sendQuestionWithButtons` (lines 171-185).
- **P1: Discord approval uses reactions, not buttons.** Reactions are less intuitive than buttons and can be accidentally triggered by any user. The question flow already uses buttons correctly.
- **P2: No confirmation feedback on Slack button press.** After clicking Allow/Deny, the response uses `replace_original: false` (line 84), so the original message with buttons remains visible. Users might click again.
- **P2: Timeout values are fixed.** 120s for approvals and 300s for questions are not configurable. Some workflows may need longer timeouts.

### Improvements
1. **Fix Slack action handler leak**
   - Use unique action IDs per request (e.g., `approve_${requestId}`) and remove handlers in cleanup
   - File: `src/slack/interactions.ts` lines 78-96
   - Priority: **P1**

2. **Migrate Discord approvals to buttons**
   - Replace reaction-based approval with button-based (matching the question flow pattern)
   - File: `src/discord/interactions.ts` lines 18-70
   - Priority: **P1**

3. **Replace original message after Slack approval**
   - Change `replace_original: false` to `replace_original: true` or update the original message to remove buttons
   - File: `src/slack/interactions.ts` line 84
   - Priority: **P2**

4. **Make timeouts configurable via environment variables**
   - Add `DISCODE_APPROVAL_TIMEOUT_MS` and `DISCODE_QUESTION_TIMEOUT_MS`
   - Priority: **P2**

---

## 6. File Sharing

### Current State
- `src/bridge/message-file-handler.ts` orchestrates download -> container injection -> marker building
- `src/infra/file-downloader.ts` handles download with 25MB limit, auto-prunes cache at 100 files
- Supported types: images (png, jpg, gif, webp), documents (pdf, docx, pptx, xlsx, csv, json, txt)
- Files are saved with timestamp-prefixed names under `{projectPath}/.discode/files/`
- `extractFilePaths` in `parser.ts` scans agent output for absolute file paths and auto-attaches them

### Problems
- **P1: Silent skip on unsupported/oversized files.** When a user sends an unsupported file type or a file over 25MB, it is silently ignored. Only `console.warn` is logged (file-downloader.ts lines 72-73, 79). The user receives no feedback.
- **P2: No file type guidance.** Users don't know which file types are supported until they try and fail.
- **P2: SVG and BMP not in SUPPORTED_FILE_TYPES.** `parser.ts` line 151 lists `.svg` and `.bmp` in FILE_EXTENSIONS for path extraction, but `SUPPORTED_FILE_TYPES` in `types/index.ts` doesn't include `image/svg+xml` or `image/bmp`. This inconsistency means the system tries to attach SVG/BMP files from agent output but won't accept them as uploads.
- **P2: No preview for document files.** PDF, DOCX, PPTX, XLSX files are sent as raw attachments with no text preview or summary.

### Improvements
1. **Notify users when files are skipped**
   - When a file is skipped (unsupported type or oversized), send a brief message to the channel: "Skipped file `filename.xyz`: unsupported type" or "Skipped file `largefile.zip`: exceeds 25MB limit"
   - File: `src/infra/file-downloader.ts` -- return skip reasons alongside downloaded files
   - File: `src/bridge/message-file-handler.ts` -- post skip messages to channel
   - Priority: **P1**

2. **Add SVG and BMP to SUPPORTED_FILE_TYPES**
   - Add `image/svg+xml` and `image/bmp` to the const array
   - File: `src/types/index.ts` line 155-167
   - Priority: **P2**

3. **Add file type help text**
   - When all attachments are skipped, include supported types list in the skip message
   - Priority: **P2**

---

## 7. Idle State Management

### Current State
- `handleSessionIdle` in `hook-event-handlers.ts` is the main idle handler
- On idle: clears thinking timer, finalizes streaming message with usage stats, marks pending as completed, posts response text/files/prompts
- `buildFinalizeHeader` creates "Done * 1,234 tokens * $0.05" summary
- Thinking text is truncated at 12K chars with "(truncated)" suffix
- Prompt choices (AskUserQuestion) are delivered as interactive buttons via `sendQuestionWithButtons`

### Problems
- **P1: "Done" finalize is premature when prompt is pending.** When the agent asks a question, the streaming message shows "Done" but the agent is actually waiting for user input. This is confusing.
- **P2: Usage stats posted as separate message.** After "Done", a usage line is posted as a new message. This clutters the channel with metadata that most users don't need.
- **P2: Thinking text always posted.** Extended thinking content is posted to the channel (up to 12K chars in a code block). This is very noisy for most users and floods the channel.
- **P1: No clear "waiting for your input" state.** When AskUserQuestion fires, there's no visual distinction in the streaming message between "done processing" and "waiting for response".

### Improvements
1. **Show "Waiting for input" instead of "Done" when prompt is pending**
   - In `handleSessionIdle`, check if `promptQuestions` or `promptText` exists; if so, finalize with "Waiting for input..." instead of "Done"
   - File: `src/bridge/hook-event-handlers.ts` lines 208-215
   - Priority: **P1**

2. **Make thinking text opt-in**
   - Add environment variable `DISCODE_SHOW_THINKING=true|false` (default: false)
   - Only post thinking block when enabled
   - File: `src/bridge/hook-idle-response.ts` lines 64-81
   - Priority: **P2**

3. **Fold usage stats into finalize header only**
   - Usage is already in the finalize header ("Done * tokens * cost"). Remove the separate `postUsageToChannel` call to reduce noise.
   - Or make it opt-in via `DISCODE_SHOW_USAGE=true|false`
   - File: `src/bridge/hook-event-handlers.ts` line 219
   - Priority: **P2**

---

## 8. Onboarding

### Current State
- Two onboarding paths: TUI wizard (`onboard-wizard.ts`, requires Bun) and fallback CLI (`onboard.ts`)
- CLI flow: choose platform -> configure tokens -> choose runtime mode -> choose default AI CLI -> OpenCode permissions -> telemetry opt-in
- After onboarding, user is directed to `cd <project> && discode new`
- No in-chat welcome or help when the bot first connects to a Discord/Slack channel

### Problems
- **P1: No in-chat welcome message.** When the bot joins a channel or a new project is created, there's no introductory message explaining what the bot does or how to interact with it.
- **P2: No help command.** Users in Discord/Slack have no way to ask the bot for available commands or usage instructions.
- **P2: Error messages during onboarding are technical.** "Discord login failed: invalid bot token" is clear, but other errors (e.g., module loading failures in `onboard-wizard.ts`) expose internal implementation details.
- **P2: TUI wizard requires Bun.** If Bun is not installed, the fallback is an error message telling users to install Bun, which is a friction point.

### Improvements
1. **Add welcome message when bot joins a channel**
   - When `createAgentChannels` creates a new channel, send an introductory message explaining the bot's purpose and basic usage
   - File: `src/discord/channels.ts` and `src/slack/channels.ts` -- add welcome message after channel creation
   - Priority: **P1**

2. **Add in-chat help response**
   - When a user types "help" or "/help" in a mapped channel, respond with a brief usage guide
   - File: `src/discord/client.ts` and `src/slack/client.ts` -- add help detection in message handler
   - Priority: **P2**

3. **Graceful TUI fallback**
   - When Bun is not available, fall through to the CLI onboarding instead of erroring
   - File: `src/cli/commands/onboard-wizard.ts` line 22-41
   - Priority: **P2**

---

## Priority Summary

### P0 (Immediate)
| # | Issue | File | Line |
|---|-------|------|------|
| 1 | Korean-only error context label | `src/bridge/hook-event-handlers.ts` | 63 |

### P1 (Important)
| # | Issue | File | Line |
|---|-------|------|------|
| 2 | No markdown-to-mrkdwn conversion for Slack | `src/capture/parser.ts` | 144 |
| 3 | Long lines silently truncated | `src/capture/parser.ts` | 89 |
| 4 | No "waiting for input" state distinction | `src/bridge/hook-event-handlers.ts` | 208 |
| 5 | Slack action handler memory leak | `src/slack/interactions.ts` | 93 |
| 6 | Discord approvals use reactions not buttons | `src/discord/interactions.ts` | 18 |
| 7 | Silent file skip with no user feedback | `src/infra/file-downloader.ts` | 72 |
| 8 | No recovery guidance in error messages | `src/bridge/hook-event-handlers.ts` | 61 |
| 9 | Tool failure messages lack context | `src/bridge/hook-event-handlers.ts` | 264 |
| 10 | No welcome message on bot join | `src/discord/channels.ts` | - |
| 11 | Hourglass persists during AskUserQuestion | `src/bridge/hook-event-handlers.ts` | 197 |
| 12 | "Done" shown when agent is waiting for input | `src/bridge/hook-event-handlers.ts` | 208 |

### P2 (Later)
| # | Issue | File | Line |
|---|-------|------|------|
| 13 | No chunk numbering for multi-part messages | `src/capture/parser.ts` | - |
| 14 | Agent name not shown in start message | `src/bridge/pending-message-tracker.ts` | 91 |
| 15 | Thinking timer starts at 10s | `src/bridge/hook-event-handlers.ts` | 46 |
| 16 | Generic "Processing..." fallback | `src/bridge/streaming-message-updater.ts` | 110 |
| 17 | Buffer fallback failures invisible | `src/bridge/message-buffer-fallback.ts` | 168 |
| 18 | Slack approval buttons not replaced after click | `src/slack/interactions.ts` | 84 |
| 19 | Fixed timeout values | `src/discord/interactions.ts` | 23 |
| 20 | SVG/BMP type inconsistency | `src/types/index.ts` | 155 |
| 21 | Thinking text always posted (noisy) | `src/bridge/hook-idle-response.ts` | 64 |
| 22 | Usage stats as separate message (noisy) | `src/bridge/hook-event-handlers.ts` | 219 |
| 23 | No in-chat help command | `src/discord/client.ts` | - |
| 24 | TUI wizard requires Bun with no fallback | `src/cli/commands/onboard-wizard.ts` | 22 |
