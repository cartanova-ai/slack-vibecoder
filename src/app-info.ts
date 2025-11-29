/**
 * 앱 시작 시점의 정보를 관리하는 모듈
 */

// 앱 시작 시점의 커밋 해시 저장
let appStartCommitHash: string | null = null;

/**
 * 앱 시작 시점의 커밋 해시를 설정합니다.
 */
export function setAppStartCommitHash(commitHash: string): void {
  appStartCommitHash = commitHash;
}

/**
 * 앱 시작 시점의 커밋 해시를 가져옵니다.
 */
export function getAppStartCommitHash(): string | null {
  return appStartCommitHash;
}
