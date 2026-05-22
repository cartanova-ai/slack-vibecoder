import { execSync } from "node:child_process";
import * as pty from "node-pty";

let claudePath: string | null = null;

function findClaude(): string {
  if (claudePath) return claudePath;
  try {
    claudePath = execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    claudePath = "/usr/local/bin/claude";
  }
  return claudePath;
}

export interface PtyHandle {
  onExit: Promise<{ exitCode: number; signal: number }>;
  kill(): void;
}

export function spawnClaude(
  args: string[],
  options: {
    cwd?: string;
    proxyPort: number;
    signal?: AbortSignal;
  },
): PtyHandle {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v != null),
  ) as Record<string, string>;
  env.ANTHROPIC_BASE_URL = `http://localhost:${options.proxyPort}`;

  const proc = pty.spawn(findClaude(), args, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: options.cwd ?? process.cwd(),
    env,
  });

  proc.onData(() => {});

  const onExit = new Promise<{ exitCode: number; signal: number }>((resolve) => {
    proc.onExit(({ exitCode, signal }) => {
      resolve({ exitCode, signal: signal ?? 0 });
    });
  });

  let killed = false;

  function kill() {
    if (killed) return;
    killed = true;
    try {
      proc.kill();
    } catch {}
  }

  if (options.signal) {
    if (options.signal.aborted) {
      kill();
    } else {
      options.signal.addEventListener("abort", kill, { once: true });
    }
  }

  return { onExit, kill };
}
