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
      delete fwdHeaders["accept-encoding"];

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
