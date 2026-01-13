# chat.update 에러 처리 개선 플랜

## 문제 상황
- `onResult`에서 최종 메시지 업데이트 시 텍스트가 3000자 초과하면 Slack API 에러 발생
- 현재 이 에러가 catch 안 되어서 앱 전체 크래시
- 메시지가 "작업 중..." 상태로 굳어버림

## 해결 목표
모든 chat.update 호출을 try-catch로 감싸서, 에러 발생 시:
1. 앱이 죽지 않게 함
2. 사용자에게 에러 발생 사실과 내용을 안전한 길이로 잘라서 알려줌

## 수정 대상 (app.ts)

### 1. onProgress 내 chat.update (358-364라인)
```typescript
// 변경 전
await client.chat.update({
  channel,
  ts: responseTs,
  text: fallbackText,
  blocks: progressBlocks,
});

// 변경 후
try {
  await client.chat.update({
    channel,
    ts: responseTs,
    text: fallbackText,
    blocks: progressBlocks,
  });
} catch (error) {
  console.error(`[${new Date().toISOString()}] onProgress chat.update 실패:`, error);
  // 진행 중 업데이트 실패는 무시 (다음 업데이트에서 재시도)
}
```

### 2. onResult 내 chat.update (440-445라인)
```typescript
// 변경 전
await client.chat.update({
  channel,
  ts: responseTs,
  text: fallbackText,
  blocks: finalBlocks,
});

// 변경 후
try {
  await client.chat.update({
    channel,
    ts: responseTs,
    text: fallbackText,
    blocks: finalBlocks,
  });
} catch (error) {
  console.error(`[${new Date().toISOString()}] onResult chat.update 실패:`, error);
  // 에러 메시지를 안전한 길이(500자)로 잘라서 사용자에게 알림
  const errorMessage = error instanceof Error ? error.message : String(error);
  const truncatedError = errorMessage.slice(0, 500);
  const errorBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${getUserMention(userId)} 작업은 완료되었으나, 결과 메시지 표시 중 오류가 발생했습니다.\n\n오류: \`${truncatedError}\`\n\n(메시지가 너무 길어 Slack 제한을 초과했을 수 있습니다)`,
      },
    },
  ];
  try {
    await client.chat.update({
      channel,
      ts: responseTs,
      text: "작업 완료 - 결과 표시 오류",
      blocks: errorBlocks,
    });
  } catch {
    // 이것마저 실패하면 로그만 남김
    console.error(`[${new Date().toISOString()}] 에러 메시지 표시도 실패`);
  }
}
```

### 3. onResult 내 3초 반복 업데이트 (450-463라인)
이건 이미 try-catch로 감싸져 있으므로 그대로 유지

### 4. onError 내 chat.update (505-510라인)
```typescript
// 변경 전
await client.chat.update({
  channel,
  ts: responseTs,
  text: fallbackText,
  blocks: errorBlocks,
});

// 변경 후
try {
  await client.chat.update({
    channel,
    ts: responseTs,
    text: fallbackText,
    blocks: errorBlocks,
  });
} catch (updateError) {
  console.error(`[${new Date().toISOString()}] onError chat.update 실패:`, updateError);
  // 최소한의 텍스트 메시지라도 전송 시도
  try {
    await client.chat.update({
      channel,
      ts: responseTs,
      text: `${getUserMention(userId)} 오류 발생 (상세 표시 실패)`,
      blocks: [],
    });
  } catch {
    console.error(`[${new Date().toISOString()}] 최소 에러 메시지 표시도 실패`);
  }
}
```

## 추가 고려사항
- truncateForSlack 함수의 기본값을 2500 → 2800으로 올려도 되지만, 근본적으로 에러 처리가 되어있으면 큰 문제 아님
- 불필요해진 race condition 관련 코드(isCompleted 플래그, 3초 반복 등)는 일단 유지 (제거는 별도 작업)

## 테스트 방법
1. 수정 후 빌드 확인: `pnpm build`
2. 재시작 후 긴 응답 유발하는 작업 요청해보기
