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

function buildArgs(
  prompt: string,
  sessionId?: string,
  isResume?: boolean,
): string[] {
  const args: string[] = [
    "--permission-mode",
    "bypassPermissions",
  ];
  if (sessionId) {
    if (isResume) {
      args.push("--resume", sessionId);
    } else {
      args.push("--session-id", sessionId);
    }
  }
  args.push(prompt);
  return args;
}

export async function* queryInteractive(
  prompt: string,
  options: QueryOptions = {},
): AsyncGenerator<ClaudeEvent> {
  const proxy = await createSseProxy();
  const args = buildArgs(prompt, options.sessionId, options.isResume);
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
  let finished = false;

  try {
    ptyHandle.onExit.then(() => {
      setTimeout(() => proxy.close(), 500);
    });

    for await (const event of proxy.events) {
      if (options.signal?.aborted || finished) break;

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
          if (delta?.stop_reason === "end_turn") {
            finished = true;
          }
          outputTokens = usage?.output_tokens ?? outputTokens;
          break;
        }

        case "message_stop": {
          if (finished) {
            // end_turn 완료 → suggestion 등 후속 API 호출 무시하고 즉시 종료
            setTimeout(() => ptyHandle.kill(), 2000);
          }
          break;
        }
      }
    }

    const finalText = (lastTextYielded || textBuffer).trim();
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
