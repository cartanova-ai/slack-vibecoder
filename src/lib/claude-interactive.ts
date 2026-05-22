import { spawnClaude } from "./pty-runner";
import { createSseProxy, type SseEvent } from "./sse-proxy";

/**
 * claude -p의 stream-json과 대응하는 이벤트 타입.
 *
 * - tool_use: 도구 호출 (claude -p의 assistant tool_use 블록과 동일)
 * - progress: 도구 호출 턴의 텍스트 ("검색하겠습니다" 등). claude -p의 assistant text와 동일하나,
 *   인터랙티브 모드에서는 최종 응답이 여러 API 턴에 걸쳐 조각으로 오기 때문에
 *   progress(표시용, 교체 가능)와 text(누적 완료된 최종 응답)를 분리함.
 * - text: end_turn 시점의 전체 응답 텍스트. 조각이 아닌 누적 완료본.
 * - result: text와 동일한 텍스트 + 세션/토큰 메타데이터.
 */
export type ClaudeEvent =
  | { type: "tool_use"; name: string; input: Record<string, unknown> }
  | { type: "progress"; text: string }
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

  let currentToolName = "";
  let currentToolInput = "";

  // 현재 API 응답(메시지) 내 텍스트 — text_delta를 바로 누적
  let messageText = "";

  // 턴 간 누적 (마지막 tool_use 이후)
  let accumulatedText = "";
  let outputTokens = 0;
  let done = false;

  try {
    ptyHandle.onExit.then(() => setTimeout(() => proxy.close(), 500));

    for await (const event of proxy.events) {
      if (options.signal?.aborted || done) break;

      switch (event.type) {
        case "message_start": {
          currentToolName = "";
          currentToolInput = "";
          messageText = "";
          break;
        }

        case "content_block_start": {
          const block = event.content_block as { type: string; name?: string } | undefined;
          if (block?.type === "tool_use") {
            currentToolName = block.name ?? "";
            currentToolInput = "";
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta as { type: string; text?: string; partial_json?: string } | undefined;
          if (delta?.type === "text_delta" && delta.text) {
            messageText += delta.text;
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
          }
          break;
        }

        case "message_delta": {
          const md = event as SseEvent;
          const stopReason = (md.delta as { stop_reason?: string })?.stop_reason;
          outputTokens = (md.usage as { output_tokens?: number })?.output_tokens ?? outputTokens;

          const text = messageText.trim();

          if (stopReason === "tool_use") {
            if (text) {
              yield { type: "progress", text };
            }
            accumulatedText = "";
          } else if (stopReason === "end_turn") {
            if (text) accumulatedText += text;
            const finalText = accumulatedText.trim();
            if (finalText) {
              yield { type: "text", text: finalText };
            }
            done = true;
          } else {
            if (text) {
              accumulatedText += text;
              yield { type: "progress", text: accumulatedText.trim() };
            }
          }
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
      text: accumulatedText.trim(),
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
