import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";

const UPSTREAM = "https://api.anthropic.com";

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

export interface SseProxy {
  port: number;
  events: AsyncGenerator<SseEvent>;
  close(): void;
}

export async function createSseProxy(): Promise<SseProxy> {
  let pushEvent: ((event: SseEvent) => void) | null = null;
  let endStream: (() => void) | null = null;
  const eventQueue: SseEvent[] = [];
  let done = false;
  let waiting: ((value: IteratorResult<SseEvent>) => void) | null = null;

  function push(event: SseEvent) {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: event, done: false });
    } else {
      eventQueue.push(event);
    }
  }

  function end() {
    done = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve({ value: undefined as unknown as SseEvent, done: true });
    }
  }

  pushEvent = push;
  endStream = end;

  async function* generateEvents(): AsyncGenerator<SseEvent> {
    while (true) {
      if (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      } else if (done) {
        return;
      } else {
        const event = await new Promise<IteratorResult<SseEvent>>((resolve) => {
          waiting = resolve;
        });
        if (event.done) return;
        yield event.value;
      }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", UPSTREAM);
    const isMessages = req.url?.includes("/v1/messages") && req.method === "POST";

    const reqChunks: Buffer[] = [];
    req.on("data", (c: Buffer) => reqChunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(reqChunks);
      const fwdHeaders: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: new URL(UPSTREAM).host,
      };
      // Claude CLI가 gzip 압축된 응답을 보내면 SSE를 plaintext로 읽을 수 없으므로 제거합니다.
      delete fwdHeaders["accept-encoding"];

      // 인터랙티브 모드에서는 quota 체크(max_tokens=1), 타이틀 생성, suggestion 등
      // 부가 API 호출이 발생합니다. 이들은 tools가 0개이므로 이 조건으로 걸러냅니다.
      let isConversation = false;
      if (isMessages) {
        try {
          const parsed = JSON.parse(body.toString());
          isConversation = (parsed.tools?.length ?? 0) > 0;
        } catch {}
      }

      const proxyReq = https.request(
        url,
        {
          method: req.method ?? "GET",
          headers: fwdHeaders,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);

          if (isConversation && proxyRes.statusCode === 200) {
            // SSE 라인 버퍼: TCP 청크 경계가 SSE 이벤트 경계와 일치하지 않으므로,
            // 불완전한 마지막 줄은 버퍼에 남겨두고 다음 청크와 합칩니다.
            let buffer = "";

            proxyRes.on("data", (chunk: Buffer) => {
              res.write(chunk);

              buffer += chunk.toString();
              const lines = buffer.split("\n");
              buffer = lines.pop()!;

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const jsonStr = line.slice(6).trim();
                if (!jsonStr) continue;
                try {
                  pushEvent?.(JSON.parse(jsonStr));
                } catch {}
              }
            });

            proxyRes.on("end", () => res.end());
          } else {
            proxyRes.pipe(res);
          }
        },
      );

      proxyReq.on("error", (err) => {
        console.error(`[sse-proxy] upstream error: ${err.message}`);
        res.writeHead(502);
        res.end("Bad Gateway");
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  });

  // 포트 0으로 바인드하면 OS가 남는 포트를 자동 할당합니다.
  // 요청마다 프록시를 새로 만들므로 포트 충돌이 없습니다.
  const port = await new Promise<number>((resolve) => {
    server.listen(0, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  return {
    port,
    events: generateEvents(),
    close() {
      endStream?.();
      server.close();
    },
  };
}
