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
  // node-pty는 env에 null 값이 있으면 posix_spawnp가 실패하므로 필터링합니다.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v != null),
  ) as Record<string, string>;
  // Claude CLI의 API 호출을 로컬 프록시로 우회하여 SSE를 캡처합니다.
  env.ANTHROPIC_BASE_URL = `http://localhost:${options.proxyPort}`;

  // PTY로 spawn해야 Claude CLI가 인터랙티브 모드(cc_entrypoint=cli)로 동작합니다.
  // stdin이 pipe이면 자동으로 --print 모드(cc_entrypoint=sdk-cli)로 전환되어
  // 6/15 이후 별도 크레딧 풀에서 과금됩니다.
  const proc = pty.spawn(findClaude(), args, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: options.cwd ?? process.cwd(),
    env,
  });

  // PTY stdout은 ANSI escape가 섞인 TUI 출력입니다. 읽지 않으면 버퍼가 차서
  // 프로세스가 멈추므로, 비워주기만 합니다. 실제 응답은 SSE 프록시에서 캡처합니다.
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
