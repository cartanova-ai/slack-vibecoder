# 큐잉 시스템 구현 플랜

## 개요

한 스레드 내에서 메시지 처리 중 새 메시지가 들어오면, 즉시 처리하지 않고 큐에 넣어 순차적으로 처리하는 시스템.

## 현재 문제점

- 같은 스레드에서 답변 중 새 질문이 오면:
  - 기존 작업이 abort 안 되고 계속 실행
  - 응답 메시지가 2개 생김
  - 리소스 낭비 및 사용자 혼란

## 목표 동작

1. 처리 중인 메시지가 있을 때 새 멘션 수신
2. 새 메시지에 대해 즉시 응답하되, 내용은 "큐잉됨" 안내 + 버튼 2개
   - "즉시 처리" 버튼: 현재 작업 중단하고 이 메시지 바로 처리
   - "취소" 버튼: 큐에서 제거
3. 현재 작업이 끝나면 큐 순서대로 다음 메시지 처리
4. "즉시 처리" 누르면:
   - 현재 작업 abort
   - 해당 메시지 즉시 처리 시작
   - 처리 완료 후, 남은 큐 아이템 순서대로 처리

## 자료구조 설계

### ThreadQueue (새 파일: src/thread-queue.ts)

```typescript
interface QueuedMessage {
  id: string;              // 고유 ID (uuid)
  userQuery: string;       // 사용자 질문
  userId: string;          // 요청한 사용자
  channel: string;         // 채널 ID
  responseTs: string;      // "큐잉됨" 메시지의 ts (나중에 업데이트용)
  queuedAt: Date;          // 큐에 들어간 시간
  status: 'queued' | 'cancelled';
}

interface ThreadState {
  isProcessing: boolean;           // 현재 처리 중인지
  currentHandler: ResponseHandler | null;  // 현재 응답 핸들러
  currentMessageId: string | null; // 현재 처리 중인 메시지 ID
  queue: QueuedMessage[];          // 대기 중인 메시지들
}

class ThreadQueueManager {
  private threads: Map<string, ThreadState>;  // threadTs -> ThreadState

  // 메서드들
  isProcessing(threadTs: string): boolean;
  startProcessing(threadTs: string, handler: ResponseHandler, messageId: string): void;
  finishProcessing(threadTs: string): void;

  enqueue(threadTs: string, message: QueuedMessage): void;
  dequeue(threadTs: string): QueuedMessage | null;
  cancelQueued(threadTs: string, messageId: string): boolean;
  prioritize(threadTs: string, messageId: string): QueuedMessage | null;

  getQueuedMessage(threadTs: string, messageId: string): QueuedMessage | null;
  getQueueLength(threadTs: string): number;
}
```

### 기존 파일 변경

#### session-manager.ts
- 변경 없음 (Claude 세션 관리는 그대로 유지)

#### app.ts
- `activeHandlers` 제거 → `ThreadQueueManager` 사용
- 멘션 이벤트 핸들러 로직 변경
- 새 버튼 액션 핸들러 추가: `process_now`, `cancel_queued`
- 큐 처리 루프 함수 추가

#### response-handler.ts
- 변경 없음 (개별 응답 처리는 그대로)

#### slack-message.ts
- `buildQueuedMessage()` 함수 추가

## 구현 순서

### Phase 1: ThreadQueueManager 구현

1. `src/thread-queue.ts` 파일 생성
2. `QueuedMessage`, `ThreadState` 인터페이스 정의
3. `ThreadQueueManager` 클래스 구현
   - `isProcessing()`: 해당 스레드가 처리 중인지 확인
   - `startProcessing()`: 처리 시작 마킹
   - `finishProcessing()`: 처리 완료 마킹
   - `enqueue()`: 큐에 메시지 추가
   - `dequeue()`: 큐에서 다음 메시지 꺼내기 (FIFO)
   - `cancelQueued()`: 특정 메시지 취소
   - `prioritize()`: 특정 메시지를 큐에서 빼서 반환 (즉시 처리용)

### Phase 2: Slack 메시지 빌더 추가

1. `slack-message.ts`에 `buildQueuedMessage()` 추가
   - 파라미터: userId, threadTs, messageId, queuePosition
   - 출력: "큐잉됨" 안내 텍스트 + 즉시처리/취소 버튼
   - 버튼 value에 messageId 포함

### Phase 3: app.ts 이벤트 핸들러 수정

1. `activeHandlers` 제거, `threadQueueManager` import
2. `app_mention` 핸들러 수정:
   ```
   if (threadQueueManager.isProcessing(threadTs)) {
     // 큐잉 메시지 전송
     // enqueue()
   } else {
     // 기존 로직대로 바로 처리
     // startProcessing()
   }
   ```
3. 새 액션 핸들러 추가:
   - `process_now`: 현재 작업 abort → 해당 메시지 처리 시작
   - `cancel_queued`: 큐에서 제거, 메시지 업데이트 ("취소됨")

### Phase 4: 큐 처리 루프

1. `processNextInQueue(threadTs)` 함수 구현
   - `finishProcessing()` 호출 후 자동으로 다음 큐 아이템 처리
   - 큐가 비어있으면 종료
2. `onResult`, `onError` 콜백에서 `processNextInQueue()` 호출

### Phase 5: 취소된 메시지 UI 처리

1. `buildCancelledMessage()` 함수 추가
2. 취소 버튼 클릭 시 메시지 업데이트

## Race Condition 방지 전략

### 동시성 이슈 지점

1. **isProcessing 체크와 enqueue 사이**
   - 문제: 체크 후 enqueue 전에 기존 작업이 끝날 수 있음
   - 해결: ThreadQueueManager 내부에서 atomic하게 처리

2. **즉시 처리 버튼 클릭 시**
   - 문제: abort 후 새 작업 시작 전에 다른 요청이 끼어들 수 있음
   - 해결: prioritize() 호출과 startProcessing()을 atomic하게 처리

3. **큐 처리 중 새 요청**
   - 문제: processNextInQueue 실행 중 새 멘션 도착
   - 해결: isProcessing 상태를 dequeue 전에 유지

### 구현 방식

```typescript
class ThreadQueueManager {
  // 모든 상태 변경 메서드는 동기적으로 실행
  // Node.js 싱글스레드 특성 활용
  // async 메서드 내에서도 상태 변경 부분은 await 없이 즉시 실행

  tryStartProcessing(threadTs: string, handler: ResponseHandler, messageId: string): boolean {
    const state = this.getOrCreateState(threadTs);
    if (state.isProcessing) {
      return false;  // 이미 처리 중
    }
    state.isProcessing = true;
    state.currentHandler = handler;
    state.currentMessageId = messageId;
    return true;
  }
}
```

## 테스트 시나리오

1. **기본 큐잉**
   - 처리 중 새 메시지 → 큐잉됨 표시
   - 처리 완료 → 자동으로 다음 처리

2. **즉시 처리**
   - 큐잉된 메시지에서 "즉시 처리" 클릭
   - 현재 작업 중단됨 확인
   - 클릭한 메시지 처리 시작됨 확인

3. **취소**
   - 큐잉된 메시지에서 "취소" 클릭
   - 메시지가 "취소됨"으로 업데이트됨 확인
   - 다른 큐 아이템은 영향 없음 확인

4. **여러 메시지 큐잉**
   - 처리 중 3개 메시지 연속 전송
   - 모두 큐잉됨 확인
   - 처리 완료 후 순서대로 처리됨 확인

5. **중간 즉시 처리**
   - A 처리 중, B, C, D 큐잉
   - C에서 "즉시 처리" 클릭
   - A 중단 → C 처리 → B → D 순서 확인

## 파일 변경 요약

| 파일 | 변경 유형 | 설명 |
|------|---------|------|
| `src/thread-queue.ts` | 신규 | ThreadQueueManager 클래스 |
| `src/slack-message.ts` | 수정 | buildQueuedMessage(), buildCancelledMessage() 추가 |
| `src/app.ts` | 수정 | 큐잉 로직 통합, 새 액션 핸들러 |
| `src/session-manager.ts` | 없음 | 변경 없음 |
| `src/response-handler.ts` | 없음 | 변경 없음 |
| `src/claude-handler.ts` | 없음 | 변경 없음 |

## 예상 코드 증가량

- thread-queue.ts: ~150줄
- slack-message.ts: ~40줄 추가
- app.ts: ~80줄 변경/추가
- 총: ~270줄 순증가

## 의사결정 사항

1. **큐 최대 크기**: 제한 없음 (메모리 기반, 실제로 한 스레드에 수십 개 쌓일 일 없음)
2. **큐잉 메시지 타임아웃**: 없음 (세션 정리 시 함께 정리)
3. **응답 메시지 분리 문제**: 수용 (복잡도 대비 이득 없음)
