---
title: "feat: SDK를 node-pty 인터랙티브로 교체"
type: feat
status: active
date: 2026-05-22
---

# SDK → node-pty 인터랙티브 교체

## Overview

`@instantlyeasy/claude-code-sdk-ts`를 제거하고, node-pty + ANTHROPIC_BASE_URL 프록시 기반 인터랙티브 모드로 교체한다. 6/15 과금 풀 분리 대응. PoC 검증 완료.

## 구현 구조

```
src/lib/
  claude-interactive.ts   ← 공개 API: queryInteractive() → AsyncGenerator<ClaudeEvent>
  sse-proxy.ts            ← HTTP 프록시 + SSE 라인버퍼 파싱
  pty-runner.ts           ← node-pty spawn/kill + AbortSignal 연동
```

## Phase 1: `src/lib/sse-proxy.ts`

SSE tee 프록시. 요청은 그대로 포워딩하고, 응답 SSE 이벤트를 캡처한다.

```typescript
// src/lib/sse-proxy.ts
interface SseProxy {
  port: number;
  events: AsyncGenerator<SseEvent>;
  close(): void;
}

function createSseProxy(): Promise<SseProxy>
```

**핵심 구현:**

- `http.createServer` + `https.request`로 `api.anthropic.com`에 포워딩
- `accept-encoding` 헤더 제거 (plaintext SSE 수신)
- `server.listen(0)` → OS가 포트 할당
- **라인 버퍼링**: `chunk.toString().split("\n")`이 아니라, 잔여 데이터를 버퍼에 유지하여 개행 기준으로 완전한 라인만 파싱

```typescript
// 라인 버퍼 패턴
let buffer = "";
proxyRes.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop()!; // 마지막 불완전 라인은 버퍼에 유지
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      // parse & yield
    }
  }
});
```

- **필터링**: `tools > 0`인 POST `/v1/messages` 요청의 SSE만 캡처. 나머지(quota, 타이틀, suggestion)는 투명 포워딩만.
  - 요청 body를 파싱하여 `tools` 필드 확인
  - 요청 body 버퍼링은 필요하지만, Claude API 요청은 어차피 JSON이고 upstream에 한 번에 전달해야 하므로 문제 없음

**이벤트 타입:**

```typescript
type SseEvent =
  | { type: "content_block_start"; index: number; content_block: { type: "text" | "tool_use" | "thinking"; name?: string; id?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } | { type: "thinking_delta"; thinking: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string }; usage: { output_tokens: number } }
  | { type: "message_stop" }
  | { type: "message_start"; message: { id: string } }
```

## Phase 2: `src/lib/pty-runner.ts`

node-pty로 claude 프로세스를 관리한다.

```typescript
// src/lib/pty-runner.ts
interface PtyHandle {
  onExit: Promise<{ exitCode: number; signal: number }>;
  kill(): void;
}

function spawnClaude(args: string[], options: {
  cwd: string;
  proxyPort: number;
  signal?: AbortSignal;
}): PtyHandle
```

**핵심 구현:**

- `pty.spawn(claudePath, args, { name: "xterm-256color", cols: 120, rows: 30, env: { ...process.env, ANTHROPIC_BASE_URL: "http://localhost:{port}" } })`
- `claudePath`: `which claude` 결과 또는 하드코딩 경로
- PTY stdout: 무시 (디버그 로깅만)
- **AbortSignal 연동**: `signal.addEventListener("abort", () => proc.kill())`
- `onExit`: Promise로 종료 감지 — 비정상 종료(exitCode !== 0, 129 제외) 시 에러 전파
  - exitCode 129 = SIGHUP (우리가 kill한 것) → 정상
- **spawn-helper 권한**: package.json postinstall 스크립트로 `chmod +x` 자동화

**인자 빌드:**

```typescript
function buildArgs(prompt: string, sessionId?: string): string[] {
  const args: string[] = [];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);
  return args;
}
```

- 첫 호출: `claude "프롬프트"` → Claude CLI가 세션 ID를 자동 생성
- 이후 호출: `claude --resume <sid> "프롬프트"`
- 세션 ID: `--session-id`로 직접 지정 (PoC 검증 완료, `randomUUID()` 사용)

## Phase 3: `src/lib/claude-interactive.ts`

프록시 + PTY를 조합하여 `AsyncGenerator<ClaudeEvent>`를 제공한다.

```typescript
// src/lib/claude-interactive.ts
type ClaudeEvent =
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string }
  | { type: "result"; text: string; sessionId: string; outputTokens: number }
  | { type: "error"; error: Error }

interface QueryOptions {
  cwd?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

async function* queryInteractive(prompt: string, options: QueryOptions): AsyncGenerator<ClaudeEvent>
```

**핵심 흐름:**

```typescript
async function* queryInteractive(prompt, options) {
  const proxy = await createSseProxy();
  const args = buildArgs(prompt, options.sessionId);
  const pty = spawnClaude(args, { cwd: options.cwd, proxyPort: proxy.port, signal: options.signal });

  try {
    // SSE 이벤트 상태 머신
    let currentToolName = "";
    let currentToolInput = "";
    let textBuffer = "";
    let outputTokens = 0;
    let lastStopReason = "";

    for await (const event of proxy.events) {
      switch (event.type) {
        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            currentToolName = event.content_block.name!;
            currentToolInput = "";
          } else if (event.content_block.type === "text") {
            textBuffer = "";
          }
          break;

        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            textBuffer += event.delta.text;
          } else if (event.delta.type === "input_json_delta") {
            currentToolInput += event.delta.partial_json;
          }
          break;

        case "content_block_stop":
          if (currentToolName) {
            const input = JSON.parse(currentToolInput || "{}");
            yield { type: "tool_use", name: currentToolName, input };
            currentToolName = "";
          } else if (textBuffer) {
            yield { type: "text", text: textBuffer };
          }
          break;

        case "message_delta":
          lastStopReason = event.delta.stop_reason;
          outputTokens = event.usage?.output_tokens ?? 0;
          break;

        case "message_stop":
          if (lastStopReason === "end_turn") {
            // 최종 턴 완료 — 잠시 대기 후 PTY kill
            // (tool_use 턴이면 CLI가 자동으로 다음 API 호출을 하므로 proxy.events가 계속됨)
          }
          break;
      }
    }

    // 프록시 이벤트 스트림이 끝남 = PTY가 종료됨
    yield { type: "result", text: textBuffer, sessionId: options.sessionId ?? "", outputTokens };

  } finally {
    pty.kill();
    proxy.close();
  }
}
```

**상태 머신 핵심:**

- `tool_use` 턴: `content_block_start(tool_use)` → `input_json_delta` 누적 → `content_block_stop` → **yield tool_use** → `message_stop(stop_reason=tool_use)` → CLI가 도구 실행 → 다음 API 호출 자동 시작
- `end_turn` 턴: `content_block_start(text)` → `text_delta` 누적 → `content_block_stop` → **yield text** → `message_stop(stop_reason=end_turn)` → 완료
- **멀티턴 루프는 CLI가 알아서 처리**. 프록시는 그냥 모든 API 호출의 SSE를 순서대로 보내줌.

**종료 감지:**

- PTY 프로세스가 종료되면 프록시에 더 이상 요청이 오지 않음 → proxy.events 스트림 종료
- 하지만 spawn+kill 전략이므로, `message_stop(end_turn)` 후에 PTY를 kill해야 함
- **전략**: `message_stop` + `stop_reason=end_turn` 감지 → 2초 대기(stop hook 마무리) → PTY kill → proxy.events 종료 → finally에서 정리

**리소스 정리 보장:**

- `try/finally`로 PTY와 프록시가 어떤 경우에도 정리됨
- AbortSignal로 중단 시에도 finally 블록 실행
- PTY 비정상 종료 시 `onExit` Promise가 에러로 reject → for await 루프 탈출 → finally

## Phase 4: `src/claude-handler.ts` 수정

SDK 빌더 패턴을 `for await` 소비 패턴으로 교체한다.

**Before (SDK):**

```typescript
import { type ContentBlock, claude } from "@instantlyeasy/claude-code-sdk-ts";

claudeBuilder.query(prompt).stream(async () => { /* 콜백들에서 처리 */ });
```

**After (queryInteractive):**

```typescript
import { queryInteractive, type ClaudeEvent } from "./lib/claude-interactive";

const stream = queryInteractive(prompt, {
  cwd: process.env.CLAUDE_CWD,
  sessionId: session.claudeSessionId ?? undefined,
  signal: abortSignal,
});

for await (const event of stream) {
  if (abortSignal.aborted) break;

  switch (event.type) {
    case "tool_use": {
      toolCallCount++;
      const input = event.input;
      const description = (input.description as string) || "";
      const command = (input.command as string) || "";
      // ... 기존 도구 정보 구성 로직 그대로
      currentToolInfo = `🔧 *${event.name}*${details ? "\n" + details : ""}`;
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
      break;
    }
    case "text": {
      progressText = event.text;
      const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
      break;
    }
    case "result": {
      resultText = event.text || progressText;
      if (event.sessionId && !session.claudeSessionId) {
        sessionManager.updateClaudeSessionId(threadTs, event.sessionId);
      }
      break;
    }
    case "error": {
      throw event.error;
      break;
    }
  }
}

// for await 루프 종료 = 완료
const finalText = resultText || progressText;
const durationSeconds = Math.round((Date.now() - startTime) / 1000);
await callbacks.onResult(finalText, { durationSeconds, toolCallCount });
```

**변경 없는 것들:**
- `StreamCallbacks` 인터페이스 (onProgress, onResult, onError)
- `app.ts` 호출부
- `session-manager.ts` (claudeSessionId 저장 패턴 그대로)
- `response-handler.ts`
- `thread-queue.ts`

**세션 ID 변경점:**
- 기존: SDK → API 응답의 `session_id` → `sessionManager.updateClaudeSessionId()`
- 신규: `queryInteractive` 호출 전에 `randomUUID()`로 세션 ID 생성 → `--session-id`로 전달 → 이후 `--resume`으로 사용
- `session-manager.ts`의 `getOrCreateSession()` 시점에 세션 ID를 미리 생성

## Phase 5: 패키지 정리

- `pnpm remove @instantlyeasy/claude-code-sdk-ts`
- `node-pty`는 이미 추가됨
- `src/claude.test.ts`에서 SDK import 제거 및 테스트 교체
- package.json postinstall: `chmod +x node_modules/**/node-pty/**/spawn-helper` 추가
- `ContentBlock` 타입: `src/lib/claude-interactive.ts`에 직접 정의 (ClaudeEvent로 대체)

## Acceptance Criteria

- [ ] `@instantlyeasy/claude-code-sdk-ts` 의존성 완전 제거
- [ ] 슬랙 멘션 → Claude 응답 → 슬랙 메시지 업데이트 동작 (e2e)
- [ ] 도구 사용 시 `🔧 *도구명*` + 상세 정보 표시 (기존과 동일)
- [ ] 텍스트 응답이 진행 중 + 최종 결과로 표시 (기존과 동일)
- [ ] `--resume`으로 동일 스레드 내 멀티턴 대화 유지
- [ ] "멈춰!" 버튼으로 중단 → PTY kill + 프록시 정리
- [ ] 서로 다른 스레드에서 동시 요청 → 각각 독립 처리
- [ ] 프록시 `cc_entrypoint=cli` fingerprint 유지 (sdk-cli 아님)
- [ ] onProgress/onResult race condition 없음 (for await 순차 처리)
- [ ] PTY 비정상 종료 시 에러 메시지 표시 + 리소스 정리

## 변경 범위

| 파일 | 변경 |
|------|------|
| `src/lib/sse-proxy.ts` | **신규** |
| `src/lib/pty-runner.ts` | **신규** |
| `src/lib/claude-interactive.ts` | **신규** |
| `src/claude-handler.ts` | SDK 빌더 → for await 패턴으로 교체 |
| `src/session-manager.ts` | 세션 생성 시 UUID 미리 생성 |
| `package.json` | SDK 제거, postinstall 추가 |
| `src/claude.test.ts` | SDK import 제거, 테스트 교체 |

`src/app.ts`, `src/response-handler.ts`, `src/thread-queue.ts` — 변경 없음.
