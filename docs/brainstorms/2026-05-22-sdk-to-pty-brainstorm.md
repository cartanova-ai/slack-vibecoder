# SDK → node-pty 인터랙티브 교체

**날짜**: 2026-05-22
**상태**: 브레인스톰 완료

## 무엇을 만드는가

`@instantlyeasy/claude-code-sdk-ts`를 제거하고, node-pty + ANTHROPIC_BASE_URL 프록시 기반의 인터랙티브 모드 Claude 실행 모듈로 교체한다.

**동기**: 2026-06-15부터 `claude -p`(cc_entrypoint=sdk-cli)가 별도 크레딧 풀($100~$200/월)로 과금됨. node-pty로 인터랙티브 모드(cc_entrypoint=cli)를 유지하면 기존 구독 풀 사용 가능. PoC로 fingerprint 동일 확인 완료.

## 왜 이 접근인가

- **PoC 검증 완료**: node-pty spawn → cc_entrypoint=cli, user-agent=cli, system prompt 동일
- **프록시 SSE 캡처 검증 완료**: accept-encoding 제거만 하면 plaintext SSE를 stream-json과 동일하게 파싱 가능
- **--resume 멀티턴 검증 완료**: spawn+kill 후 --resume으로 대화 맥락 유지 확인

## 핵심 결정

### 1. 프록시: 앱 내장 (단일 프로세스)
- 슬랙 봇 프로세스 안에 HTTP 프록시를 내장
- 별도 프로세스 관리 불필요

### 2. 프로세스 수명: 매번 spawn+kill
- 요청마다 node-pty로 claude 프로세스를 새로 띄우고, 응답 후 kill
- `--resume <session-id>`로 세션 유지 (기존 sessionManager 패턴 그대로)
- MCP 핸드셰이크 오버헤드(~3-5초)는 감수 — 단순함이 더 중요

### 3. 동시성: 프로세스마다 프록시 포트 할당
- 각 claude 프로세스에 고유 포트의 프록시를 할당
- SSE 응답이 자동으로 분리됨 — correlation 로직 불필요
- 포트 범위 관리 (예: 13000-13100)

### 4. 인터페이스: 기존 콜백 구조 유지
- claude-handler.ts의 onToolUse, onAssistant, onMessage 패턴 그대로
- app.ts 변경 없음
- ContentBlock 타입은 직접 정의 (SDK 의존 제거)
- 토큰 단위 스트리밍 안 함 (슬랙 rate limit 때문에 의미 없음)

### 5. SSE 필터링
- `tools > 0`인 요청만 캡처 (실제 대화)
- quota 체크(max_tokens=1), 타이틀 생성, suggestion은 무시
- tool_use 후 추가 턴이 올 수 있으므로, 마지막 message_stop까지 대기

## 아키텍처

```
슬랙 멘션
  │
  ▼
app.ts → claude-handler.ts → claude-sdk.ts (신규)
                                  │
                                  ├─ 1. 고유 포트로 프록시 시작
                                  ├─ 2. ANTHROPIC_BASE_URL=localhost:PORT
                                  ├─ 3. node-pty spawn: claude --resume <sid> "프롬프트"
                                  ├─ 4. 프록시에서 SSE 캡처
                                  │     ├─ content_block_start (tool_use) → onToolUse 콜백
                                  │     ├─ text_delta 누적 → onAssistant 콜백 (턴 끝)
                                  │     └─ message_stop → 턴 종료 감지
                                  ├─ 5. 모든 턴 완료 → onMessage(result) 콜백
                                  ├─ 6. proc.kill()
                                  └─ 7. 프록시 종료, 포트 반환
```

## 변경 범위

| 파일 | 변경 |
|------|------|
| `src/claude-sdk.ts` | **신규** — node-pty + 프록시 + SSE 파싱 + 콜백 |
| `src/claude-handler.ts` | import 변경, SDK 빌더 패턴 → 새 함수 호출로 교체 |
| `src/session-manager.ts` | 변경 없음 (그대로 사용) |
| `src/app.ts` | 변경 없음 |
| `package.json` | `@instantlyeasy/claude-code-sdk-ts` 제거, `node-pty` 추가 |

## 검증 계획

1. **e2e**: Slack MCP로 #티켓 채널에서 바이브코더 멘션 → 응답 확인
2. **회귀 체크**: 기존과 동일한 프롬프트로 도구 호출, 중간 텍스트, 최종 응답 비교
3. **동시성**: 여러 스레드에서 동시 멘션 → 각각 정상 응답
4. **중단**: "멈춰!" 버튼 → proc.kill() 정상 동작
5. **세션 유지**: 같은 스레드에서 연속 대화 → 맥락 유지

## 기존 대비 개선

### onProgress/onResult race condition 해결
기존 SDK에서 11건 이상의 커밋을 유발한 경합 조건 문제가 구조적으로 해소됨:
- SSE 이벤트 순서가 프로토콜 레벨에서 보장 (text_delta → content_block_stop → message_stop)
- 종료 시점이 `message_stop` 이벤트로 명확 — "스트림 끝났는데 콜백 안 왔다" 불가능
- 프록시에서 text_delta를 모아서 한 번에 콜백 → 타이머와의 3자 경합 제거

## 열린 질문

없음 — PoC에서 모든 기술적 불확실성 해소됨.
