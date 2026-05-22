import { spawnClaude } from "./pty-runner";
import { createSseProxy, type SseEvent } from "./sse-proxy";

export type ClaudeEvent =
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "text"; text: string }
  | { type: "result"; text: string; sessionId: string; outputTokens: number }
  | { type: "error"; error: Error };

export interface QueryOptions {
  cwd?: string;
  sessionId?: string;
  isResume?: boolean;
  signal?: AbortSignal;
}

function buildArgs(prompt: string, sessionId?: string, isResume?: boolean): string[] {
  const args: string[] = ["--permission-mode", "bypassPermissions"];
  if (sessionId) {
    args.push(isResume ? "--resume" : "--session-id", sessionId);
  }
  args.push(prompt);
  return args;
}

/**
 * Claude CLI를 인터랙티브 모드로 실행하고 SSE 이벤트를 파싱합니다.
 *
 * 이벤트 흐름 (claude -p의 stream-json과 동일하게):
 * - tool_use: 도구 호출 시 즉시 yield (이름 + input)
 * - text: end_turn 메시지의 전체 텍스트를 한 번만 yield
 * - result: 최종 텍스트 + 세션 ID + 토큰 수
 *
 * 내부적으로 메시지 단위(message_start ~ message_stop) 상태 머신으로 동작.
 * - tool_use 턴의 텍스트는 무시 (중간 말: "검색하겠습니다" 등)
 * - end_turn 턴의 텍스트 블록들을 합쳐서 최종 응답으로 사용
 * - suggestion/타이틀 등 후속 API 호출은 end_turn 이후 무시
 */
export async function* queryInteractive(
  prompt: string,
  options: QueryOptions = {},
): AsyncGenerator<ClaudeEvent> {
  const proxy = await createSseProxy();
  const ptyHandle = spawnClaude(buildArgs(prompt, options.sessionId, options.isResume), {
    cwd: options.cwd,
    proxyPort: proxy.port,
    signal: options.signal,
  });

  // 현재 메시지(API 응답) 내 상태
  let currentToolName = "";
  let currentToolInput = "";
  let textBuffer = "";
  let messageTextParts: string[] = [];

  // 전체 세션 상태
  let outputTokens = 0;
  let finalText = "";
  let done = false;

  try {
    ptyHandle.onExit.then(() => setTimeout(() => proxy.close(), 500));

    for await (const event of proxy.events) {
      if (options.signal?.aborted || done) break;

      switch (event.type) {
        case "message_start": {
          // 새 API 응답 시작 — 메시지 내 상태 초기화
          currentToolName = "";
          currentToolInput = "";
          textBuffer = "";
          messageTextParts = [];
          break;
        }

        case "content_block_start": {
          const block = event.content_block as { type: string; name?: string } | undefined;
          if (block?.type === "tool_use") {
            currentToolName = block.name ?? "";
            currentToolInput = "";
          }
          textBuffer = "";
          break;
        }

        case "content_block_delta": {
          const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            textBuffer += delta.text;
          } else if (delta?.type === "input_json_delta" && delta.partial_json) {
            currentToolInput += delta.partial_json;
          }
          break;
        }

        case "content_block_stop": {
          if (currentToolName) {
            let input: Record<string, unknown> = {};
            try { input = JSON.parse(currentToolInput || "{}"); } catch {}
            yield { type: "tool_use", name: currentToolName, input };
            currentToolName = "";
            currentToolInput = "";
          } else if (textBuffer.trim()) {
            messageTextParts.push(textBuffer);
          }
          textBuffer = "";
          break;
        }

        case "message_delta": {
          const md = event as SseEvent;
          const stopReason = (md.delta as { stop_reason?: string })?.stop_reason;
          outputTokens = (md.usage as { output_tokens?: number })?.output_tokens ?? outputTokens;

          if (stopReason === "end_turn") {
            // 최종 턴 완료. 이 메시지의 텍스트를 합쳐서 yield.
            finalText = messageTextParts.join("\n").trim();
            if (finalText) {
              yield { type: "text", text: finalText };
            }
            done = true;
          }
          // tool_use 턴: 텍스트는 버림 (다음 message_start에서 초기화됨)
          break;
        }

        case "message_stop": {
          if (done) {
            setTimeout(() => ptyHandle.kill(), 2000);
          }
          break;
        }
      }
    }

    yield {
      type: "result",
      text: finalText,
      sessionId: options.sessionId ?? "",
      outputTokens,
    };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    ptyHandle.kill();
    proxy.close();
  }
}
