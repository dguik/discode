# Slack 사용자 가시성 강화 — Claude Hook 활용 구현 계획

## 배경

Slack 사용자는 터미널 화면을 직접 볼 수 없음. 현재 discode는 `Stop`(최종 응답), `PostToolUse`(Read/Edit/Write/Bash 4개만), `Notification`, `SessionStart/End`만 전달. Claude가 어떤 작업 목록을 세우고, 얼마나 진행했고, git에 무엇을 커밋했는지 등 **중간 컨텍스트가 거의 보이지 않음**.

## 우선순위별 구현 항목

| 순위 | 항목 | 변경 파일 수 | 위험도 |
|------|------|-------------|--------|
| 1 | Task 진행 상황 동기화 | 2 | 낮음 |
| 2 | Git 활동 요약 | 2 | 낮음 |
| 3 | SubagentStop 알림 | 4 | 낮음 |
| 4 | 도구 활동 메시지 강화 (Grep/Glob/Task 추가) | 1 | 낮음 |
| 5 | Plan 내용 Slack 전달 | 2 | 중간 |
| 6 | 에러 컨텍스트 강화 | 2 | 중간 |

---

## Phase 1: Task 진행 상황 동기화

### 목표

Claude가 `TaskCreate`/`TaskUpdate`를 호출할 때마다 Slack에 체크리스트 메시지를 생성/갱신하여
사용자가 작업 목록과 진행률을 한눈에 볼 수 있도록 한다.

### Slack 표시 예시

```
📋 작업 목록 (2/4 완료)
☑️ #1 Write unit tests for pure utility modules
☑️ #2 Write unit tests for state-bag modules
⬜ #3 Write unit tests for tmux modules  ← 진행 중
⬜ #4 Create create-test skill
```

### 변경 사항

#### 1-1. `src/claude/plugin/scripts/discode-tool-hook.js`

`formatToolLine()` 함수에 TaskCreate/TaskUpdate 분기 추가:

```javascript
// 기존 formatToolLine() 하단에 추가

if (toolName === "TaskCreate") {
  var subject = typeof input.subject === "string" ? input.subject : "";
  if (!subject) return "";
  return "TASK_CREATE:" + JSON.stringify({
    subject: subject,
    description: typeof input.description === "string" ? input.description : "",
    activeForm: typeof input.activeForm === "string" ? input.activeForm : "",
  });
}

if (toolName === "TaskUpdate") {
  var taskId = typeof input.taskId === "string" ? input.taskId : "";
  var status = typeof input.status === "string" ? input.status : "";
  if (!taskId) return "";
  return "TASK_UPDATE:" + JSON.stringify({
    taskId: taskId,
    status: status,
    subject: typeof input.subject === "string" ? input.subject : "",
  });
}
```

**설계 근거**: `tool.activity` 이벤트의 `text` 필드에 구조화된 prefix를 넣어서,
bridge handler 측에서 일반 도구 활동과 task 이벤트를 구분할 수 있게 한다.
기존 `handleToolActivity` 로직과 호환되면서도 새 핸들러에서 분기 가능.

#### 1-2. `src/bridge/hook-event-handlers.ts`

`handleToolActivity()` 함수 내에서 task prefix를 감지하여 별도 처리:

```typescript
// handleToolActivity() 시작 부분에 분기 추가

export async function handleToolActivity(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  deps.clearSessionLifecycleTimer(`${ctx.projectName}:${ctx.instanceKey}`);
  await deps.ensureStartMessageAndStreaming(ctx);

  // Task 진행 상황 이벤트 — 별도 메시지로 관리
  if (ctx.text?.startsWith('TASK_CREATE:') || ctx.text?.startsWith('TASK_UPDATE:')) {
    return handleTaskProgress(deps, ctx);
  }

  // ... 기존 로직 유지
}
```

**새 함수 `handleTaskProgress()`** — 같은 파일 하단에 추가:

```typescript
/** Per-instance task checklist message, updated on each TaskCreate/TaskUpdate. */
const taskChecklistMessages = new Map<string, {
  channelId: string;
  parentMessageId: string;
  messageId: string;
  tasks: Array<{ id: string; subject: string; status: string }>;
}>();

async function handleTaskProgress(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const pending = ctx.pendingSnapshot;
  if (!pending?.startMessageId || !ctx.text) return true;

  const k = `${ctx.projectName}:${ctx.instanceKey}`;
  let checklist = taskChecklistMessages.get(k);

  // 초기화: 해당 인스턴스의 첫 task 이벤트
  if (!checklist || checklist.parentMessageId !== pending.startMessageId) {
    checklist = {
      channelId: pending.channelId,
      parentMessageId: pending.startMessageId,
      messageId: '',
      tasks: [],
    };
    taskChecklistMessages.set(k, checklist);
  }

  if (ctx.text.startsWith('TASK_CREATE:')) {
    const data = JSON.parse(ctx.text.slice('TASK_CREATE:'.length));
    const nextId = String(checklist.tasks.length + 1);
    checklist.tasks.push({ id: nextId, subject: data.subject, status: 'pending' });
  } else if (ctx.text.startsWith('TASK_UPDATE:')) {
    const data = JSON.parse(ctx.text.slice('TASK_UPDATE:'.length));
    const task = checklist.tasks.find(t => t.id === data.taskId);
    if (task) {
      if (data.status) task.status = data.status;
      if (data.subject) task.subject = data.subject;
    }
  }

  // 체크리스트 메시지 렌더링
  const completedCount = checklist.tasks.filter(t => t.status === 'completed').length;
  const header = `📋 작업 목록 (${completedCount}/${checklist.tasks.length} 완료)`;
  const lines = checklist.tasks.map(t => {
    const icon = t.status === 'completed' ? '☑️' : t.status === 'in_progress' ? '🔄' : '⬜';
    return `${icon} #${t.id} ${t.subject}`;
  });
  const message = [header, ...lines].join('\n');

  try {
    if (checklist.messageId) {
      await deps.messaging.updateMessage(checklist.channelId, checklist.messageId, message);
    } else {
      const msgId = await deps.messaging.replyInThreadWithId(
        checklist.channelId, checklist.parentMessageId, message,
      );
      if (msgId) checklist.messageId = msgId;
    }
  } catch (error) {
    console.warn('Failed to update task checklist:', error);
  }

  return true;
}
```

**`handleSessionIdle()` 수정**: 기존 `threadActivityMessages.delete(k)` 옆에 `taskChecklistMessages.delete(k)` 추가하여 턴 종료 시 정리.

### 검증

```bash
npx vitest run tests/bridge/hook-event-handlers.test.ts  # 기존 테스트 통과
# + 새 테스트: TASK_CREATE/TASK_UPDATE prefix 파싱, 체크리스트 렌더링, updateMessage 호출
```

---

## Phase 2: Git 활동 요약

### 목표

`PostToolUse` Bash 이벤트 중 git commit/push를 감지하여 Slack에 간결한 요약을 전달.

### Slack 표시 예시

```
📦 Committed: "test: add 215 unit tests across 8 files"
   8 files changed, +1507 lines
🚀 Pushed to main (e92625b)
```

### 변경 사항

#### 2-1. `src/claude/plugin/scripts/discode-tool-hook.js`

`formatToolLine()` 의 Bash 분기에서 git 명령어 감지 추가:

```javascript
if (toolName === "Bash") {
  var cmd = typeof input.command === "string" ? input.command : "";
  if (!cmd) return "";

  // git commit 감지 — tool_response에서 결과 추출
  var response = typeof toolResponse === "string" ? toolResponse : "";

  if (/\bgit\s+commit\b/.test(cmd) && response) {
    var commitMatch = response.match(/\[[\w/.-]+\s+([a-f0-9]+)\]\s+(.+)/);
    var statMatch = response.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?[^,]*)?(?:,\s+(\d+)\s+deletions?)?/);
    if (commitMatch) {
      var hash = commitMatch[1];
      var msg = commitMatch[2];
      var stat = statMatch ? "\n   " + statMatch[0] : "";
      return "GIT_COMMIT:" + JSON.stringify({ hash: hash, message: msg, stat: stat.trim() });
    }
  }

  // git push 감지
  if (/\bgit\s+push\b/.test(cmd) && response) {
    var pushMatch = response.match(/([a-f0-9]+)\.\.([a-f0-9]+)\s+(\S+)\s+->\s+(\S+)/);
    if (pushMatch) {
      return "GIT_PUSH:" + JSON.stringify({
        fromHash: pushMatch[1], toHash: pushMatch[2],
        localRef: pushMatch[3], remoteRef: pushMatch[4],
      });
    }
  }

  // 기존 일반 Bash 포맷
  var truncated = cmd.length > 100 ? cmd.substring(0, 100) + "..." : cmd;
  return "\uD83D\uDCBB `" + truncated + "`";
}
```

**주의**: `tool_response` 필드 접근 필요. 현재 `main()` 에서 `input.tool_input`만 전달하고 있으므로
`toolResponse`도 추출하여 `formatToolLine` 에 전달해야 함:

```javascript
// main() 수정
var toolResponse = typeof input.tool_response === "string" ? input.tool_response : "";
var line = formatToolLine(toolName, toolInput, toolResponse);
```

```javascript
// formatToolLine 시그니처 변경
function formatToolLine(toolName, toolInput, toolResponse) {
```

#### 2-2. `src/bridge/hook-event-handlers.ts`

`handleToolActivity()` 에서 GIT_ prefix 분기:

```typescript
if (ctx.text?.startsWith('GIT_COMMIT:') || ctx.text?.startsWith('GIT_PUSH:')) {
  return handleGitActivity(deps, ctx);
}
```

```typescript
async function handleGitActivity(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const pending = ctx.pendingSnapshot;
  if (!pending?.startMessageId || !ctx.text) return true;

  let message = '';
  if (ctx.text.startsWith('GIT_COMMIT:')) {
    const data = JSON.parse(ctx.text.slice('GIT_COMMIT:'.length));
    message = `📦 Committed: "${data.message}"`;
    if (data.stat) message += `\n   ${data.stat}`;
  } else if (ctx.text.startsWith('GIT_PUSH:')) {
    const data = JSON.parse(ctx.text.slice('GIT_PUSH:'.length));
    message = `🚀 Pushed to ${data.remoteRef} (${data.toHash.slice(0, 7)})`;
  }

  if (!message) return true;

  try {
    await deps.messaging.replyInThread(pending.channelId, pending.startMessageId, message);
  } catch (error) {
    console.warn('Failed to post git activity:', error);
  }

  // streaming updater에도 표시
  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, message);
  return true;
}
```

### 검증

```bash
npx vitest run tests/bridge/hook-event-handlers.test.ts
# + 새 테스트: GIT_COMMIT/GIT_PUSH prefix 파싱, thread reply 호출
```

---

## Phase 3: SubagentStop 알림

### 목표

Claude가 Task tool로 subagent를 돌릴 때 각 subagent 완료 시 스레드에 결과 요약 표시.
현재 `SubagentStop` hook은 Claude Code에서 지원하지만 discode에서 사용하지 않음.

### Slack 표시 예시

```
🔍 Explore 완료: "Found 14 modules with zero test coverage across 7 directories"
🔍 Bash 완료: "All 215 tests passed in 383ms"
```

### 변경 사항

#### 3-1. 새 hook 스크립트: `src/claude/plugin/scripts/discode-subagent-hook.js`

```javascript
#!/usr/bin/env node
/**
 * SubagentStop hook — fires when a subagent (Task tool) completes.
 * Sends a summary to Slack so the user can track parallel work.
 */

function readStdin() { /* 기존 패턴 동일 */ }
async function postToBridge(port, payload) { /* 기존 패턴 동일 */ }

function truncate(str, maxLen) {
  if (!str) return "";
  // 첫 문단 또는 첫 2줄만 추출
  var lines = str.trim().split("\n").filter(function(l) { return l.trim().length > 0; });
  var preview = lines.slice(0, 2).join(" ").trim();
  if (preview.length > maxLen) return preview.substring(0, maxLen) + "...";
  return preview;
}

async function main() {
  var inputRaw = await readStdin();
  var input = {};
  try { input = inputRaw ? JSON.parse(inputRaw) : {}; } catch (_) { input = {}; }

  var projectName = process.env.DISCODE_PROJECT || "";
  if (!projectName) return;

  var agentType = process.env.DISCODE_AGENT || "claude";
  var instanceId = process.env.DISCODE_INSTANCE || "";
  var port = process.env.DISCODE_PORT || "18470";

  var subagentType = typeof input.agent_type === "string" ? input.agent_type : "unknown";
  var lastMessage = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";

  var summary = truncate(lastMessage, 200);
  if (!summary) return;

  try {
    await postToBridge(port, {
      projectName: projectName,
      agentType: agentType,
      ...(instanceId ? { instanceId: instanceId } : {}),
      type: "tool.activity",
      text: "SUBAGENT_DONE:" + JSON.stringify({ subagentType: subagentType, summary: summary }),
    });
  } catch (_) {}
}

main().catch(function() {});
```

#### 3-2. `src/claude/plugin/hooks/hooks.json`

SubagentStop 이벤트 등록 추가:

```json
{
  "hooks": {
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/discode-subagent-hook.js"
          }
        ]
      }
    ]
  }
}
```

#### 3-3. `src/bridge/hook-event-handlers.ts`

`handleToolActivity()` 에 SUBAGENT_DONE prefix 분기:

```typescript
if (ctx.text?.startsWith('SUBAGENT_DONE:')) {
  return handleSubagentDone(deps, ctx);
}
```

```typescript
async function handleSubagentDone(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const pending = ctx.pendingSnapshot;
  if (!pending?.startMessageId || !ctx.text) return true;

  const data = JSON.parse(ctx.text.slice('SUBAGENT_DONE:'.length));
  const message = `🔍 ${data.subagentType} 완료: "${data.summary}"`;

  try {
    await deps.messaging.replyInThread(pending.channelId, pending.startMessageId, message);
  } catch (error) {
    console.warn('Failed to post subagent completion:', error);
  }

  deps.streamingUpdater.append(ctx.projectName, ctx.instanceKey, message);
  return true;
}
```

#### 3-4. `tsup.config.ts`

`onSuccess` 에 새 스크립트 복사 추가:

```typescript
cp('src/claude/plugin/scripts/discode-subagent-hook.js', 'dist/claude/plugin/scripts/discode-subagent-hook.js');
```

### 검증

```bash
npx vitest run tests/bridge/hook-event-handlers.test.ts
# + 새 테스트: SUBAGENT_DONE prefix 파싱, thread reply
# hook 등록 검증: hooks.json에 SubagentStop 존재 확인
```

---

## Phase 4: 도구 활동 메시지 강화

### 목표

현재 Skip되는 Grep, Glob, Task, WebSearch 등 도구를 포맷하여
Slack 스레드에서 Claude의 작업 흐름을 더 자세히 볼 수 있도록 한다.

### 변경 사항

#### 4-1. `src/claude/plugin/scripts/discode-tool-hook.js`

`formatToolLine()` 에 추가 분기:

```javascript
if (toolName === "Grep") {
  var pattern = typeof input.pattern === "string" ? input.pattern : "";
  if (!pattern) return "";
  var grepPath = typeof input.path === "string" ? shortenPath(input.path, 3) : ".";
  return "🔎 Grep(`" + pattern + "` in " + grepPath + ")";
}

if (toolName === "Glob") {
  var globPattern = typeof input.pattern === "string" ? input.pattern : "";
  if (!globPattern) return "";
  return "📂 Glob(`" + globPattern + "`)";
}

if (toolName === "WebSearch") {
  var query = typeof input.query === "string" ? input.query : "";
  if (!query) return "";
  var truncQuery = query.length > 80 ? query.substring(0, 80) + "..." : query;
  return "🌐 Search(`" + truncQuery + "`)";
}

if (toolName === "WebFetch") {
  var url = typeof input.url === "string" ? input.url : "";
  if (!url) return "";
  var truncUrl = url.length > 80 ? url.substring(0, 80) + "..." : url;
  return "🌐 Fetch(`" + truncUrl + "`)";
}

if (toolName === "Task") {
  var desc = typeof input.description === "string" ? input.description : "";
  var subType = typeof input.subagent_type === "string" ? input.subagent_type : "";
  if (!desc) return "";
  return "🤖 " + subType + "(`" + desc + "`)";
}
```

### 검증

```bash
# 기존 테스트 통과 확인
npx vitest run tests/bridge/
```

---

## Phase 5: Plan 내용 Slack 전달

### 목표

Claude가 `ExitPlanMode`를 호출할 때 plan 파일 내용을 Slack에 첨부하여
사용자가 터미널 없이도 plan을 리뷰하고 승인할 수 있도록 한다.

### Slack 표시 예시

```
📋 Plan approval needed

📄 Plan 내용:
```refactor: extract buffer operations...```
(첨부 파일: quiet-percolating-firefly.md)
```

### 변경 사항

#### 5-1. `src/claude/plugin/scripts/discode-stop-hook.js`

`formatPromptText()` 의 `ExitPlanMode` 분기에서 plan 파일 경로 추출:

```javascript
} else if (block.name === "ExitPlanMode") {
  // ExitPlanMode의 input에서 plan file path가 있으면 추가
  var planInput = block.input || {};
  // Claude Code가 plan file 경로를 allowedPrompts 등에 포함할 수 있음
  // transcript에서 plan 파일 경로 검색
  parts.push("📋 Plan approval needed");
}
```

실제로는 plan 파일 경로가 transcript의 system 메시지에 포함됨 (`A plan file exists from plan mode at: /path`).
Stop hook에서 transcript를 역방향 스캔할 때 이 경로를 추출하여 `promptText`에 포함.

#### 5-2. `src/bridge/hook-event-handlers.ts`

`handleSessionIdle()` → `postPromptChoices()` 에서 plan 파일이 감지되면 첨부:

```typescript
async function postPromptChoices(messaging: MessagingClient, ctx: EventContext): Promise<void> {
  const promptText = typeof ctx.event.promptText === 'string' ? ctx.event.promptText.trim() : '';
  if (!promptText) return;

  const planFilePath = typeof ctx.event.planFilePath === 'string' ? ctx.event.planFilePath.trim() : '';
  if (planFilePath && existsSync(planFilePath)) {
    // Plan 파일을 Slack에 첨부
    await messaging.sendToChannelWithFiles(ctx.channelId, promptText, [planFilePath]);
  } else {
    await splitAndSendToChannel(messaging, ctx.channelId, promptText);
  }
}
```

### 주의사항

- Plan 파일 경로가 `~/.claude/plans/` 아래에 있으므로 projectPath 밖임 → `validateFilePaths` 우회 필요
- Plan 파일이 클 수 있으므로(2000줄+) Slack 메시지 대신 파일 첨부 사용

### 검증

```bash
npx vitest run tests/bridge/hook-event-handlers.test.ts
# + 새 테스트: planFilePath 존재 시 sendToChannelWithFiles 호출
```

---

## Phase 6: 에러 컨텍스트 강화

### 목표

에러 발생 시 최근 도구 호출 이력을 Slack 스레드에 첨부하여
"무엇을 하다가 실패했는지" 컨텍스트 제공.

### Slack 표시 예시

```
⚠️ OpenCode session error: runtime_error

최근 활동:
📖 Read(`src/runtime/vt-screen.ts`)
✏️ Edit(`src/runtime/vt-screen.ts`) +15 lines
💻 `npx vitest run tests/runtime/...`  ← 여기서 실패
```

### 변경 사항

#### 6-1. `src/bridge/hook-event-handlers.ts`

`handleSessionError()` 에서 `threadActivityMessages`의 마지막 lines를 에러 메시지에 첨부:

```typescript
export async function handleSessionError(deps: EventHandlerDeps, ctx: EventContext): Promise<boolean> {
  const k = `${ctx.projectName}:${ctx.instanceKey}`;
  deps.clearThinkingTimer(k);

  // 최근 활동 이력 수집 (에러 컨텍스트)
  const recentActivity = deps.threadActivityMessages.get(k);
  const recentLines = recentActivity?.lines.slice(-5) || [];

  deps.threadActivityMessages.delete(k);
  deps.streamingUpdater.discard(ctx.projectName, ctx.instanceKey);
  deps.pendingTracker.markError(ctx.projectName, ctx.agentType, ctx.instanceId).catch(() => {});

  const msg = ctx.text || 'unknown error';
  let errorMessage = `⚠️ OpenCode session error: ${msg}`;
  if (recentLines.length > 0) {
    errorMessage += '\n\n최근 활동:\n' + recentLines.join('\n');
  }
  await deps.messaging.sendToChannel(ctx.channelId, errorMessage);
  return true;
}
```

#### 6-2. `src/bridge/hook-event-handlers.ts`

`handleSessionIdle()` 에서도 에러 응답인 경우 (text가 에러 패턴) 최근 활동을 포함할 수 있도록 동일 패턴 적용. 단, idle은 정상 종료이므로 별도 분기 불필요 — error handler에만 적용.

### 검증

```bash
npx vitest run tests/bridge/hook-event-handlers.test.ts
# + 새 테스트: error handler에서 recentLines 포함 확인
```

---

## 구현 순서 & 커밋 전략

| 단계 | Phase | 커밋 메시지 |
|------|-------|------------|
| 1 | Phase 4 (도구 포맷 추가) | `feat: format Grep/Glob/WebSearch/Task in tool activity hook` |
| 2 | Phase 1 (Task 동기화) | `feat: sync TaskCreate/TaskUpdate progress to Slack checklist` |
| 3 | Phase 2 (Git 요약) | `feat: detect git commit/push in Bash hook and post summary` |
| 4 | Phase 3 (SubagentStop) | `feat: add SubagentStop hook for parallel work visibility` |
| 5 | Phase 6 (에러 컨텍스트) | `feat: include recent tool activity in error messages` |
| 6 | Phase 5 (Plan 전달) | `feat: attach plan file content to ExitPlanMode notification` |

Phase 4를 먼저 하는 이유: 가장 단순한 변경이면서 후속 Phase들의 prefix 패턴 기반이 됨.
Phase 5를 마지막으로 하는 이유: transcript 파싱 변경이 가장 복잡하고, plan 파일 경로 추출 방법을 확인해야 함.

## 아키텍처 결정 사항

### Prefix 프로토콜 (`TASK_CREATE:`, `GIT_COMMIT:`, etc.)

hook script → bridge 통신에서 `type: "tool.activity"` 를 재사용하되,
`text` 필드에 구조화된 prefix를 넣어 handler에서 분기하는 방식 채택.

**대안 검토**:
- 새 이벤트 타입 추가 (`task.progress`, `git.activity`) → pipeline에 새 handler 등록 필요, 변경 범위 큼
- 별도 HTTP 엔드포인트 → hook server 변경 필요, 과도한 엔지니어링

**선택 근거**: 기존 `tool.activity` 경로 재사용으로 pipeline/server 변경 없이 handler 레벨에서만 분기. hook script(CJS)와 handler(TS) 두 곳만 수정.

### tool_response 접근

Phase 2 (Git)에서 `input.tool_response` 필드 사용. Claude Code의 `PostToolUse` 이벤트는
`tool_response` 를 stdin JSON에 포함하므로 추가 설정 없이 접근 가능.
단, response가 매우 클 수 있으므로 git 관련 명령어에서만 파싱.

### 메시지 업데이트 vs 새 메시지

- Task 체크리스트: `updateMessage()` — 하나의 메시지를 반복 갱신 (깔끔)
- Git/Subagent: `replyInThread()` — 이벤트마다 새 스레드 답글 (시간순 이력)
- 에러 컨텍스트: 기존 `sendToChannel()` 에 추가 텍스트 — 별도 메시지 불필요

## 테스트 전략

각 Phase의 테스트:

1. **discode-tool-hook.js**: `formatToolLine()` 의 새 분기 단위 테스트 (Node.js로 직접 실행)
2. **hook-event-handlers.ts**: prefix 파싱 + messaging mock 호출 검증
3. **통합 테스트**: 실제 Slack workspace에서 E2E 확인 (수동)

```bash
# 전체 테스트 스위트
npx vitest run
npx tsc --noEmit
```
