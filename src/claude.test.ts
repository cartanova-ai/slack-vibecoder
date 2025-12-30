import { claude } from "@instantlyeasy/claude-code-sdk-ts";
import { describe, expect, it } from "vitest";

describe("Claude SDK 실제 통합 테스트", () => {
  it("Claude 함수를 호출할 수 있다", () => {
    expect(claude).toBeDefined();
    expect(typeof claude).toBe("function");
  });

  it("간단한 프롬프트에 응답을 받을 수 있다", async () => {
    let response = "";

    await claude()
      .query("안녕하세요! 간단히 인사만 해주세요. 한 문장으로 답변해주세요.")
      .stream(async (message) => {
        if (message.type === "assistant" && message.content && message.content.length > 0) {
          const textContent = message.content.find((c: any) => c.type === "text") as any;
          if (textContent && "text" in textContent) {
            response = textContent.text;
          }
        }
      });

    expect(response.length).toBeGreaterThan(0);
    expect(response).toBeTruthy();
    console.log("\n✅ 응답:", response);
  }, 60000); // 60초 타임아웃

  it("스트리밍 응답을 실시간으로 받을 수 있다", async () => {
    const chunks: string[] = [];
    let chunkCount = 0;

    console.log("\n📡 스트리밍 응답:");
    await claude()
      .query(
        "/Users/potados/Projects/sonamu에 가서 현재 변경된 내용들이 무엇이고 왜 변경되었는지 설명해줘.",
      )
      .stream(async (message) => {
        console.log(JSON.stringify(message, null, 2));

        if (message.type === "assistant" && message.content && message.content.length > 0) {
          const textContent = message.content.find((c: any) => c.type === "text") as any;
          if (textContent && "text" in textContent) {
            chunks.push(textContent.text);
            chunkCount++;
            //process.stdout.write(textContent.text);
          }
        }
      });
    console.log("\n");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("").length).toBeGreaterThan(0);
    console.log(`\n✅ 총 ${chunkCount}개의 메시지를 받았습니다.`);
  }, 60000);

  it("코드 관련 질문에 응답할 수 있다", async () => {
    let response = "";

    await claude()
      .query("TypeScript에서 두 숫자를 더하는 함수를 작성해주세요.")
      .stream(async (message) => {
        if (message.type === "assistant" && message.content && message.content.length > 0) {
          const textContent = message.content.find((c: any) => c.type === "text") as any;
          if (textContent && "text" in textContent) {
            response = textContent.text;
          }
        }
      });

    expect(response.length).toBeGreaterThan(0);
    expect(response.toLowerCase()).toMatch(/function|const|=>|number/i);
    console.log("\n✅ 코드 응답:", response);
  }, 60000);

  it("긴 응답도 스트리밍으로 받을 수 있다", async () => {
    let response = "";
    let updateCount = 0;

    console.log("\n📡 긴 응답 스트리밍:");
    await claude()
      .query("JavaScript의 클로저(closure)에 대해 간단히 설명해주세요. 2-3문장으로 답변해주세요.")
      .stream(async (message) => {
        if (message.type === "assistant" && message.content && message.content.length > 0) {
          const textContent = message.content.find((c: any) => c.type === "text") as any;
          if (textContent && "text" in textContent) {
            response = textContent.text;
            updateCount++;
            process.stdout.write(textContent.text);
          }
        }
      });
    console.log("\n");

    expect(response.length).toBeGreaterThan(50); // 충분히 긴 응답
    console.log(`\n✅ 총 ${updateCount}번 업데이트, ${response.length}자 응답`);
  }, 60000);

  it.only("Slack MCP 서버를 사용하여 Slack 작업을 수행할 수 있다", async () => {
    const slackBotToken = process.env.SLACK_BOT_TOKEN;
    const slackTeamId = process.env.SLACK_TEAM_ID;

    if (!slackBotToken || !slackTeamId) {
      console.warn(
        "\n⚠️  SLACK_BOT_TOKEN과 SLACK_TEAM_ID 환경 변수가 설정되지 않아 테스트를 건너뜁니다.",
      );
      console.log(
        "사용법: SLACK_BOT_TOKEN=xoxb-... SLACK_TEAM_ID=T0000000000 pnpm test:integration",
      );
      return;
    }

    let response = "";
    let toolUseCount = 0;

    console.log("\n📡 Slack MCP 테스트 시작...\n");

    await claude()
      .skipPermissions()
      .onToolUse((tool) => {
        toolUseCount++;
        console.log(`\n🔧 Tool 사용: ${tool.name}`);
        if (tool.input) {
          console.log(`   입력:`, JSON.stringify(tool.input, null, 2));
        }
      })
      .query("Slack에서 내가 속한 채널 목록을 보여줘. 최대 5개만.")
      .stream(async (message) => {
        // 응답 텍스트 수집
        if (message.type === "assistant" && message.content && message.content.length > 0) {
          const textContent = message.content.find((c: any) => c.type === "text") as any;
          if (textContent && "text" in textContent) {
            response = textContent.text;
            process.stdout.write(textContent.text);
          }
        }
      });

    console.log("\n");

    expect(response.length).toBeGreaterThan(0);
    console.log(`\n✅ 응답 길이: ${response.length}자`);
    if (toolUseCount > 0) {
      console.log(`✅ 사용된 Tool 수: ${toolUseCount}개`);
    }
  }, 120000); // 120초 타임아웃 (MCP 서버 초기화 시간 고려)
});
