/**
 * 스레드 기반 세션 관리자
 * 슬랙 스레드 ID(thread_ts)를 키로 사용하여 Claude 세션을 관리합니다.
 */

interface Session {
  claudeSessionId: string | null;
  abortController: AbortController;
  createdAt: Date;
  lastActivity: Date;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  /**
   * 스레드에 대한 세션을 가져오거나 새로 생성합니다.
   * @param threadTs 슬랙 스레드 타임스탬프 (없으면 메시지 ts 사용)
   */
  getOrCreateSession(threadTs: string): Session {
    let session = this.sessions.get(threadTs);

    if (!session) {
      session = {
        claudeSessionId: null,
        abortController: new AbortController(),
        createdAt: new Date(),
        lastActivity: new Date(),
      };
      this.sessions.set(threadTs, session);
    }

    session.lastActivity = new Date();
    return session;
  }

  /**
   * 세션의 Claude 세션 ID를 업데이트합니다.
   */
  updateClaudeSessionId(threadTs: string, sessionId: string): void {
    const session = this.sessions.get(threadTs);
    if (session) {
      session.claudeSessionId = sessionId;
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
    for (const [threadTs, session] of this.sessions) {
      if (now - session.lastActivity.getTime() > maxAgeMs) {
        this.deleteSession(threadTs);
      }
    }
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
