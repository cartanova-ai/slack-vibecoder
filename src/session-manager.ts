/**
 * 스레드 기반 세션 관리자
 * 슬랙 스레드 ID(thread_ts)를 키로 사용하여 Claude 세션을 관리합니다.
 * thread-sessions.json에 매핑을 영속화하여 재시작 후에도 세션을 복원합니다.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSIONS_FILE = join(process.cwd(), "thread-sessions.json");

interface PersistedSession {
  claudeSessionId: string;
  hasBeenUsed: boolean;
  createdAt: string;
  lastActivity: string;
}

interface Session {
  // 세션 생성 시 UUID를 미리 발급합니다. 기존 SDK는 API 응답에서 session_id를 받았지만,
  // PTY 인터랙티브 모드에서는 API 응답을 직접 읽을 수 없으므로 우리가 먼저 지정합니다.
  // 첫 요청: --session-id <uuid>, 이후 요청: --resume <uuid>
  claudeSessionId: string;
  // 첫 요청과 이후 요청에서 CLI 인자가 다릅니다 (--session-id vs --resume).
  // --resume은 기존 세션이 디스크에 존재해야 하므로, 첫 사용 여부를 추적합니다.
  hasBeenUsed: boolean;
  abortController: AbortController;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(SESSIONS_FILE)) return;
      const raw: Record<string, PersistedSession> = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
      let loaded = 0;
      for (const [threadTs, p] of Object.entries(raw)) {
        this.sessions.set(threadTs, {
          claudeSessionId: p.claudeSessionId,
          hasBeenUsed: p.hasBeenUsed,
          abortController: new AbortController(),
          createdAt: new Date(p.createdAt),
          lastActivity: new Date(p.lastActivity),
        });
        loaded++;
      }
      if (loaded > 0) {
        console.log(`[${new Date().toISOString()}] 📂 디스크에서 ${loaded}개 세션 복원됨`);
      }
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ⚠️ 세션 파일 로드 실패:`, e);
    }
  }

  private saveToDisk(): void {
    try {
      const data: Record<string, PersistedSession> = {};
      for (const [threadTs, s] of this.sessions) {
        data[threadTs] = {
          claudeSessionId: s.claudeSessionId,
          hasBeenUsed: s.hasBeenUsed,
          createdAt: s.createdAt.toISOString(),
          lastActivity: s.lastActivity.toISOString(),
        };
      }
      writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ⚠️ 세션 파일 저장 실패:`, e);
    }
  }

  /**
   * 스레드에 대한 세션을 가져오거나 새로 생성합니다.
   * @param threadTs 슬랙 스레드 타임스탬프 (없으면 메시지 ts 사용)
   */
  getOrCreateSession(threadTs: string): Session {
    let session = this.sessions.get(threadTs);
    if (!session) {
      session = {
        claudeSessionId: randomUUID(),
        hasBeenUsed: false,
        abortController: new AbortController(),
        createdAt: new Date(),
        lastActivity: new Date(),
      };
      this.sessions.set(threadTs, session);
      this.saveToDisk();
      console.log(
        `[${new Date().toISOString()}] 🆕 새 세션 생성: ${session.claudeSessionId.substring(0, 12)}... (스레드: ${threadTs})`,
      );
    }

    session.lastActivity = new Date();
    return session;
  }

  markSessionUsed(threadTs: string): void {
    const session = this.sessions.get(threadTs);
    if (session) {
      session.hasBeenUsed = true;
      this.saveToDisk();
    }
  }

  /**
   * 세션을 중단합니다 (abort signal 발생).
   */
  abortSession(threadTs: string): boolean {
    const session = this.sessions.get(threadTs);
    if (session && !session.abortController.signal.aborted) {
      session.abortController.abort();
      // 새 AbortController 생성하여 다음 요청을 위해 준비
      session.abortController = new AbortController();
      return true;
    }
    return false;
  }

  /**
   * 세션을 삭제합니다.
   */
  deleteSession(threadTs: string): void {
    const session = this.sessions.get(threadTs);
    if (session) {
      session.abortController.abort();
      this.sessions.delete(threadTs);
    }
  }

  /**
   * 오래된 세션을 정리합니다.
   * @param maxAgeMs 최대 세션 유지 시간 (기본 1시간)
   */
  cleanupOldSessions(maxAgeMs: number = 60 * 60 * 1000): void {
    const now = Date.now();
    let deleted = 0;
    for (const [threadTs, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        session.abortController.abort();
        this.sessions.delete(threadTs);
        deleted++;
      }
    }
    if (deleted > 0) this.saveToDisk();
  }

  /**
   * 세션이 존재하는지 확인합니다.
   */
  hasSession(threadTs: string): boolean {
    return this.sessions.has(threadTs);
  }

  /**
   * 세션의 AbortSignal을 가져옵니다.
   */
  getAbortSignal(threadTs: string): AbortSignal | null {
    const session = this.sessions.get(threadTs);
    return session?.abortController.signal ?? null;
  }
}

export const sessionManager = new SessionManager();
export type { Session };
