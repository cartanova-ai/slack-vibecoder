/**
 * Slack 메시지 블록 빌더
 *
 * 슬랙 Block Kit 메시지를 생성하는 함수들.
 * 여러 곳에서 비슷한 블록 구조를 만들던 것을 여기로 모았음.
 */

import { getAppStartCommitHash, getAppVersion } from "./app-info";

// Slack mrkdwn 텍스트 블록 제한: 3000자. 여유를 두고 2500자로 제한.
const MAX_TEXT_LENGTH = 2500;

/**
 * 사용자 멘션 태그를 반환합니다.
 * userId가 "unknown"이면 빈 문자열을 반환합니다.
 */
export function getUserMention(userId: string): string {
  return userId === "unknown" ? "" : `<@${userId}>`;
}

/**
 * 버전 정보 문자열을 생성합니다.
 * 예: ", v2.1.0 (6575b2f)"
 */
export function getVersionInfoText(): string {
  const version = getAppVersion();
  const commitHash = getAppStartCommitHash();
  const parts: string[] = [];

  if (version) {
    parts.push(`v${version}`);
  }
  if (commitHash) {
    parts.push(`(${commitHash.substring(0, 7)})`);
  }

  return parts.length > 0 ? `, ${parts.join(" ")}` : "";
}

/**
 * 경과/소요 시간 문자열을 생성합니다.
 * 예: "2분 15초"
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return minutes > 0 ? `${minutes}분 ${secs}초` : `${secs}초`;
}

/**
 * 슬랙 블록 텍스트를 안전한 길이로 자릅니다.
 */
export function truncateForSlack(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}

/**
 * 긴 텍스트를 Slack 메시지 한도에 맞게 분할합니다.
 * 줄바꿈이나 단어 경계에서 자르려고 시도합니다.
 */
export function splitTextForSlack(text: string, maxLength: number = MAX_TEXT_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 최대 길이 내에서 줄바꿈 찾기
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    // 줄바꿈이 없거나 너무 앞에 있으면 공백에서 자르기
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }

    // 공백도 없으면 그냥 자르기
    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

// ============================================================================
// 블록 빌더들
// ============================================================================

type SlackBlock = Record<string, unknown>;

/**
 * 메타데이터 context 블록을 생성합니다.
 * 예: "_2분 15초 경과, 도구 5회 호출, v2.1.0 (6575b2f)_"
 */
export function buildMetadataBlock(
  timeStr: string,
  toolCallCount: number,
  status: "경과" | "소요",
): SlackBlock {
  const versionInfo = getVersionInfoText();
  const text = `_${timeStr} ${status}, 도구 ${toolCallCount}회 호출${versionInfo}_`;

  return {
    type: "context",
    elements: [{ type: "mrkdwn", text }],
  };
}

/**
 * 텍스트 section 블록을 생성합니다.
 */
export function buildTextBlock(text: string): SlackBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text },
  };
}

/**
 * "멈춰!" 버튼 actions 블록을 생성합니다.
 */
export function buildStopButtonBlock(threadTs: string): SlackBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "🛑 멈춰!", emoji: true },
        action_id: "stop_claude",
        value: threadTs,
      },
    ],
  };
}

// ============================================================================
// 전체 메시지 빌더들
// ============================================================================

interface MessageBlocks {
  blocks: SlackBlock[];
  fallbackText: string;
}

/**
 * 초기 "생각하는 중..." 메시지를 생성합니다.
 */
export function buildThinkingMessage(userId: string, threadTs: string): MessageBlocks {
  const userMention = getUserMention(userId);
  const versionInfo = getVersionInfoText();

  const blocks = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_0초 경과, 도구 0회 호출${versionInfo}_` }],
    },
    buildTextBlock(`${userMention} 🤔 생각하는 중...`.trim()),
    buildStopButtonBlock(threadTs),
  ];

  return {
    blocks,
    fallbackText: `${userMention} 🤔 생각하는 중...`.trim(),
  };
}

/**
 * 진행 중 "작업 중..." 메시지를 생성합니다.
 */
export function buildProgressMessage(
  userId: string,
  threadTs: string,
  text: string,
  toolInfo: string | undefined,
  elapsedSeconds: number,
  toolCallCount: number,
): MessageBlocks {
  const userMention = getUserMention(userId);
  const timeStr = formatDuration(elapsedSeconds);

  // 메시지 텍스트 구성
  const toolInfoText = toolInfo ? `${toolInfo}\n\n` : "";
  const userTag = userMention ? `${userMention} ⏳ 작업 중...` : "⏳ 작업 중...";
  const overhead = userTag.length + toolInfoText.length + 10;
  const maxTextLength = MAX_TEXT_LENGTH - overhead;
  const truncatedText = truncateForSlack(text, maxTextLength);
  const messageText = `${userTag}\n\n${toolInfoText}${truncatedText}`;

  const blocks = [
    buildMetadataBlock(timeStr, toolCallCount, "경과"),
    buildTextBlock(messageText),
    buildStopButtonBlock(threadTs),
  ];

  return {
    blocks,
    fallbackText: userMention ? `${userMention} 작업 중...` : "작업 중...",
  };
}

/**
 * 완료된 결과 메시지를 생성합니다.
 * 텍스트가 길면 여러 청크로 분할합니다.
 */
export function buildResultMessage(
  userId: string,
  text: string,
  durationSeconds: number,
  toolCallCount: number,
): { firstMessage: MessageBlocks; additionalChunks: string[] } {
  const userMention = getUserMention(userId);
  const timeStr = formatDuration(durationSeconds);

  // 텍스트를 청크로 분할
  const overhead = userMention.length + 10;
  const maxChunkLength = MAX_TEXT_LENGTH - overhead;
  const chunks = splitTextForSlack(text, maxChunkLength);

  // 첫 번째 청크 메시지
  const firstChunkText = userMention ? `${userMention}\n\n${chunks[0]}` : chunks[0];

  const firstMessage: MessageBlocks = {
    blocks: [buildMetadataBlock(timeStr, toolCallCount, "소요"), buildTextBlock(firstChunkText)],
    fallbackText: userMention
      ? `${userMention} ${text.slice(0, 100)}...`
      : `${text.slice(0, 100)}...`,
  };

  return {
    firstMessage,
    additionalChunks: chunks.slice(1),
  };
}

/**
 * 에러 메시지를 생성합니다.
 */
export function buildErrorMessage(userId: string, errorMessage: string): MessageBlocks {
  const userMention = getUserMention(userId);
  const truncatedError = errorMessage.slice(0, 500);

  const text = userMention
    ? `${userMention} ❌ 오류가 발생했습니다:\n\`\`\`${truncatedError}\`\`\``
    : `❌ 오류가 발생했습니다:\n\`\`\`${truncatedError}\`\`\``;

  return {
    blocks: [buildTextBlock(text)],
    fallbackText: userMention ? `${userMention} 오류가 발생했습니다.` : "오류가 발생했습니다.",
  };
}

/**
 * 중단 메시지를 생성합니다.
 */
export function buildAbortedMessage(userId: string): MessageBlocks {
  const userMention = getUserMention(userId);
  const text = `${userMention} ⏹️ 작업이 중단되었습니다.`.trim();

  return {
    blocks: [buildTextBlock(text)],
    fallbackText: "작업이 중단되었습니다.",
  };
}

// ============================================================================
// 큐잉 관련 메시지 빌더들
// ============================================================================

/**
 * "큐잉됨" 메시지를 생성합니다.
 * 즉시처리/취소 버튼을 포함합니다.
 */
export function buildQueuedMessage(
  userId: string,
  threadTs: string,
  messageId: string,
  queuePosition: number,
): MessageBlocks {
  const userMention = getUserMention(userId);
  const positionText = queuePosition === 1 ? "다음 순서입니다" : `${queuePosition}번째 순서입니다`;
  const text =
    `${userMention} 📋 현재 다른 작업을 처리 중이에요. ${positionText}.\n바로 처리하고 싶으면 "즉시 처리" 버튼을 눌러주세요.`.trim();

  const blocks = [
    buildTextBlock(text),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "⚡ 즉시 처리", emoji: true },
          action_id: "process_now",
          value: JSON.stringify({ threadTs, messageId }),
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ 취소", emoji: true },
          action_id: "cancel_queued",
          value: JSON.stringify({ threadTs, messageId }),
        },
      ],
    },
  ];

  return {
    blocks,
    fallbackText: `${userMention} 큐잉됨 (${positionText})`.trim(),
  };
}

/**
 * "취소됨" 메시지를 생성합니다.
 */
export function buildCancelledMessage(userId: string): MessageBlocks {
  const userMention = getUserMention(userId);
  const text = `${userMention} 🚫 요청이 취소되었습니다.`.trim();

  return {
    blocks: [buildTextBlock(text)],
    fallbackText: "요청이 취소되었습니다.",
  };
}

/**
 * 큐에서 처리 시작 메시지를 생성합니다.
 * (큐잉 메시지를 업데이트할 때 사용)
 */
export function buildProcessingFromQueueMessage(userId: string, threadTs: string): MessageBlocks {
  const userMention = getUserMention(userId);
  const versionInfo = getVersionInfoText();

  const blocks = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_0초 경과, 도구 0회 호출${versionInfo}_` }],
    },
    buildTextBlock(`${userMention} 🤔 생각하는 중...`.trim()),
    buildStopButtonBlock(threadTs),
  ];

  return {
    blocks,
    fallbackText: `${userMention} 🤔 생각하는 중...`.trim(),
  };
}
