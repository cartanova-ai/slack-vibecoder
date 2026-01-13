/**
 * Slack Vibecoder - Claude를 활용한 슬랙 봇
 *
 * 기능:
 * - 멘션을 받으면 Claude가 작업 시작
 * - 스레드 기반 세션 관리
 * - 진행 상황 실시간 업데이트
 * - "멈춰!" 버튼으로 작업 중단
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import { setAppStartCommitHash, setAppVersion } from "./app-info";
import { abortSession, handleClaudeQuery } from "./claude-handler";
import { ResponseHandler } from "./response-handler";
import { sessionManager } from "./session-manager";
import { getUserMention } from "./slack-message";

// 환경 변수 확인
const requiredEnvVars = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "CLAUDE_CWD"];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ 환경 변수 ${envVar}가 설정되지 않았습니다.`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// 진행 중인 응답 핸들러 추적 (channel:threadTs -> ResponseHandler)
const activeHandlers = new Map<string, ResponseHandler>();

// ============================================================================
// 이벤트 핸들러
// ============================================================================

/**
 * 멘션 이벤트 핸들러
 */
app.event("app_mention", async ({ event, client, say }) => {
  const userId = event.user ?? "unknown";
  const channel = event.channel;

  // 세션 키: 항상 사용자 메시지가 스레드 루트
  const threadTs = event.thread_ts ?? event.ts;

  // 멘션에서 봇 태그 제거하고 실제 메시지 추출
  const botMentionRegex = /<@[A-Z0-9]+>/g;
  const userQuery = event.text.replace(botMentionRegex, "").trim();

  if (!userQuery) {
    await say({
      text: `${getUserMention(userId)} 무엇을 도와드릴까요? 메시지를 함께 보내주세요!`.trim(),
      thread_ts: threadTs,
    });
    return;
  }

  console.log(`[${new Date().toISOString()}] 📩 멘션 수신: ${userQuery} (스레드: ${threadTs})`);

  // 응답 핸들러 생성 및 초기 메시지 전송
  const handler = new ResponseHandler(client, channel, threadTs, userId);
  const responseTs = await handler.start();

  if (!responseTs) {
    return;
  }

  const handlerKey = `${channel}:${threadTs}`;
  activeHandlers.set(handlerKey, handler);

  console.log(`[${new Date().toISOString()}] 🤖 봇 응답 생성: ${responseTs}, 세션 키: ${threadTs}`);

  // Claude 처리
  try {
    await handleClaudeQuery(
      threadTs,
      userQuery,
      {
        onProgress: async (text, toolInfo, elapsedSeconds, toolCallCount) => {
          // 핸들러가 삭제되었으면 (중단된 경우) 업데이트 스킵
          if (!activeHandlers.has(handlerKey)) {
            return;
          }
          await handler.updateProgress(text, toolInfo, elapsedSeconds, toolCallCount);
        },

        onResult: async (text, summary) => {
          await handler.showResult(text, summary.durationSeconds, summary.toolCallCount);
          activeHandlers.delete(handlerKey);
        },

        onError: async (error) => {
          await handler.showError(error);
          activeHandlers.delete(handlerKey);
        },
      },
      channel,
    );
  } catch (error) {
    console.error("Claude 처리 중 오류:", error);
    handler.stopTimer();
    activeHandlers.delete(handlerKey);
  }
});

/**
 * "멈춰!" 버튼 액션 핸들러
 */
app.action<BlockAction<ButtonAction>>("stop_claude", async ({ body, ack }) => {
  await ack();

  const action = body.actions[0] as ButtonAction;
  const threadTs = action.value;
  const channel = body.channel?.id;

  if (!channel || !threadTs) {
    console.error("채널 또는 스레드 정보 없음");
    return;
  }

  console.log(`🛑 중단 요청: 스레드 ${threadTs}`);

  const handlerKey = `${channel}:${threadTs}`;
  const handler = activeHandlers.get(handlerKey);

  // 핸들러 제거 (먼저 제거해야 onProgress가 더 이상 호출 안됨)
  activeHandlers.delete(handlerKey);

  // 세션 중단
  const aborted = abortSession(threadTs);

  if (aborted && handler) {
    await handler.showAborted();
  }
});

// ============================================================================
// 주기적 정리
// ============================================================================

// 오래된 세션 정리 (30분마다)
setInterval(
  () => {
    sessionManager.cleanupOldSessions(60 * 60 * 1000); // 1시간 이상된 세션 정리
  },
  30 * 60 * 1000,
);

// ============================================================================
// 앱 시작
// ============================================================================

(async () => {
  const projectDir = process.env.PROJECT_DIR || process.cwd();

  // 앱 시작 시점의 커밋 해시 저장
  try {
    const commitHash = execSync("git rev-parse HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();
    setAppStartCommitHash(commitHash);
    console.log(`📌 앱 시작 시점 커밋 해시: ${commitHash}`);
  } catch (error) {
    console.warn("⚠️ 커밋 해시를 가져오지 못했습니다:", error);
  }

  // 앱 버전 저장
  try {
    const packageJsonPath = join(projectDir, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    if (packageJson.version) {
      setAppVersion(packageJson.version);
      console.log(`📦 앱 버전: v${packageJson.version}`);
    }
  } catch (error) {
    console.warn("⚠️ 버전을 가져오지 못했습니다:", error);
  }

  const port = parseInt(process.env.PORT || "3000", 10);
  await app.start(port);

  // 온라인 상태로 설정
  await app.client.users.setPresence({ presence: "auto" });

  console.log(`⚡️ Slack Vibecoder가 시작되었습니다! (포트: ${port})`);
  console.log("🤖 Socket Mode로 연결되었습니다.");
})();
