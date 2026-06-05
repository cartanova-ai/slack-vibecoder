import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "debug-logs");
const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function ensureDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function cleanOldFiles(): void {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(LOG_DIR)) {
      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > RETENTION_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

export function createFileLogger(prefix: string): {
  log(data: unknown): void;
  close(): void;
} {
  ensureDir();
  cleanOldFiles();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(LOG_DIR, `${prefix}-${ts}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  return {
    log(data: unknown) {
      const line = typeof data === "string" ? data : JSON.stringify(data);
      stream.write(line + "\n");
    },
    close() {
      stream.end();
    },
  };
}

let slackLogger: ReturnType<typeof createFileLogger> | null = null;

export function getSlackLogger(): ReturnType<typeof createFileLogger> {
  if (!slackLogger) {
    ensureDir();
    cleanOldFiles();
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(LOG_DIR, `slack-updates-${date}.jsonl`);
    const stream = fs.createWriteStream(filePath, { flags: "a" });
    slackLogger = {
      log(data: unknown) {
        const entry = {
          ts: new Date().toISOString(),
          ...(typeof data === "object" && data !== null ? data : { raw: data }),
        };
        stream.write(JSON.stringify(entry) + "\n");
      },
      close() {
        stream.end();
        slackLogger = null;
      },
    };
  }
  return slackLogger;
}
