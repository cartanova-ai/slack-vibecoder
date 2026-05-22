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
  signal?: AbortSignal;
}

function buildArgs(prompt: string, sessionId?: string): string[] {
  const args: string[] = [];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(prompt);
  return args;
}

export async function* queryInteractive(
  prompt: string,
  options: QueryOptions = {},
): AsyncGenerator<ClaudeEvent> {
  const proxy = await createSseProxy();
  const args = buildArgs(prompt, options.sessionId);
  const ptyHandle = spawnClaude(args, {
    cwd: options.cwd,
    proxyPort: proxy.port,
    signal: options.signal,
  });

  let currentToolName = "";
  let currentToolInput = "";
  let textBuffer = "";
  let lastTextYielded = "";
  let outputTokens = 0;
  let lastStopReason = "";
  let endTurnTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const exitPromise = ptyHandle.onExit.then((result) => {
      // PTY 종료 시 프록시 이벤트 스트림도 종료
      setTimeout(() => proxy.close(), 500);
      return result;
    });

    for await (const event of proxy.events) {
      if (options.signal?.aborted) break;

      switch (event.type) {
        case "content_block_start": {
          const block = (event as SseEvent).content_block as {
            type: string;
            name?: string;
          };
          if (block?.type === "tool_use") {
            currentToolName = block.name ?? "";
            currentToolInput = "";
          } else if (block?.type === "text") {
            textBuffer = "";
          }
          break;
        }

        case "content_block_delta": {
          const delta = (event as SseEvent).delta as {
            type: string;
            text?: string;
            partial_json?: string;
          };
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
            try {
              input = JSON.parse(currentToolInput || "{}");
            } catch {}
            yield { type: "tool_use", name: currentToolName, input };
            currentToolName = "";
            currentToolInput = "";
          } else if (textBuffer) {
            yield { type: "text", text: textBuffer };
            lastTextYielded = textBuffer;
          }
          break;
        }

        case "message_delta": {
          const delta = (event as SseEvent).delta as {
            stop_reason?: string;
          };
          const usage = (event as SseEvent).usage as {
            output_tokens?: number;
          };
          lastStopReason = delta?.stop_reason ?? "";
          outputTokens = usage?.output_tokens ?? outputTokens;
          break;
        }

        case "message_stop": {
          if (lastStopReason === "end_turn") {
            // 최종 턴 완료. stop hook 등 마무리 대기 후 PTY kill.
            endTurnTimer = setTimeout(() => {
              ptyHandle.kill();
            }, 2000);
          }
          // tool_use 턴이면 CLI가 도구를 실행하고 다음 API 호출을 자동으로 함.
          // proxy.events가 계속 이어지므로 루프가 계속됨.
          break;
        }
      }
    }

    yield {
      type: "result",
      text: lastTextYielded || textBuffer,
      sessionId: options.sessionId ?? "",
      outputTokens,
    };
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    if (endTurnTimer) clearTimeout(endTurnTimer);
    ptyHandle.kill();
    proxy.close();
  }
}
