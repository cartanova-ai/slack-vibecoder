/**
 * Claude 인터랙티브 핸들러
 * 슬랙 메시지를 받아 Claude에 전달하고 응답을 스트리밍합니다.
 * node-pty + SSE 프록시 기반 인터랙티브 모드를 사용합니다.
 */

import { queryInteractive } from "./lib/claude-interactive";
import { buildPrompt } from "./prompts";
import { sessionManager } from "./session-manager";

interface ExecutionSummary {
  durationSeconds: number;
  toolCallCount: number;
}

interface StreamCallbacks {
  onProgress: (
    text: string,
    toolInfo: string | undefined,
    elapsedSeconds: number,
    toolCallCount: number,
  ) => Promise<void>;
  onResult: (text: string, summary: ExecutionSummary) => Promise<void>;
  onError: (error: Error) => Promise<void>;
}

export async function handleClaudeQuery(
  threadTs: string,
  userQuery: string,
  callbacks: StreamCallbacks,
  channelId?: string,
  slackUserId?: string,
): Promise<string | null> {
  const session = sessionManager.getOrCreateSession(threadTs);
  const abortSignal = session.abortController.signal;

  let progressText = "";
  let resultText = "";
  let currentToolInfo = "";

  const startTime = Date.now();
  let toolCallCount = 0;

  try {
    console.log(
      `[${new Date().toISOString()}] 🔄 세션 ${session.claudeSessionId.substring(0, 12)}... 사용 (스레드: ${threadTs})`,
    );

    const prompt = buildPrompt(userQuery, threadTs, channelId, slackUserId);

    const stream = queryInteractive(prompt, {
      cwd: process.env.CLAUDE_CWD,
      sessionId: session.claudeSessionId,
      isResume: session.hasBeenUsed,
      signal: abortSignal,
    });
    // 스트림 생성 직후에 마킹해야 합니다. 요청이 실패하더라도
    // CLI가 세션을 디스크에 기록하므로 다음 요청은 --resume이어야 합니다.
    sessionManager.markSessionUsed(threadTs);

    for await (const event of stream) {
      if (abortSignal.aborted) break;

      switch (event.type) {
        case "tool_use": {
          toolCallCount++;

          const input = event.input;
          const description = (input.description as string) || "";
          const command = (input.command as string) || "";
          const pattern = (input.pattern as string) || "";
          const filePath = (input.file_path as string) || "";

          let details = "";
          if (description) details += description;
          if (command) details += (details ? "\n" : "") + `\`${command}\``;
          if (pattern) details += (details ? "\n" : "") + `패턴: ${pattern}`;
          if (filePath) details += (details ? "\n" : "") + `파일: ${filePath}`;

          currentToolInfo = `🔧 *${event.name}*${details ? "\n" + details : ""}`;

          const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
          await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
          break;
        }

        case "progress": {
          // progress는 도구 호출 턴의 중간 텍스트("검색하겠습니다" 등)입니다.
          // 최종 응답(text)이 오면 교체되므로, 여기서는 표시용으로만 사용합니다.
          progressText = event.text;
          const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
          await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
          break;
        }

        case "text": {
          // text는 end_turn에서 한 번만 오며, 전체 누적 응답이 담겨 있습니다.
          // progress와 달리 조각이 아닌 완성본이므로 이것이 최종 표시 텍스트입니다.
          progressText = event.text;
          const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
          await callbacks.onProgress(progressText, currentToolInfo, elapsedSeconds, toolCallCount);
          break;
        }

        case "result": {
          resultText = event.text;
          break;
        }

        case "error": {
          throw event.error;
        }
      }
    }

    if (!abortSignal.aborted) {
      const finalText = (resultText || progressText).trim();
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      await callbacks.onResult(finalText, { durationSeconds, toolCallCount });
    }

    return resultText || progressText;
  } catch (error) {
    if (abortSignal.aborted) {
      return null;
    }

    const err = error instanceof Error ? error : new Error(String(error));
    await callbacks.onError(err);
    throw err;
  }
}

export function abortSession(threadTs: string): boolean {
  return sessionManager.abortSession(threadTs);
}
