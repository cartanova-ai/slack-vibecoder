import { describe, expect, it } from "vitest";
import { queryInteractive } from "./lib/claude-interactive";

describe("Claude 인터랙티브 모드 통합 테스트", () => {
  it("간단한 프롬프트에 응답을 받을 수 있다", async () => {
    let response = "";

    for await (const event of queryInteractive(
      "안녕하세요! 간단히 인사만 해주세요. 한 문장으로 답변해주세요.",
    )) {
      if (event.type === "text") {
        response = event.text;
      }
    }

    expect(response.length).toBeGreaterThan(0);
    console.log("\n✅ 응답:", response);
  }, 60000);

  it("도구 사용이 포함된 질문에 응답할 수 있다", async () => {
    let response = "";
    const toolNames: string[] = [];

    for await (const event of queryInteractive(
      "이 프로젝트의 package.json을 읽고, 프로젝트 이름과 버전을 알려줘.",
      { cwd: process.cwd() },
    )) {
      if (event.type === "tool_use") {
        toolNames.push(event.name);
        console.log(`\n🔧 Tool 사용: ${event.name}`);
      }
      if (event.type === "text") {
        response = event.text;
      }
    }

    expect(response.length).toBeGreaterThan(0);
    expect(toolNames.length).toBeGreaterThan(0);
    console.log(`\n✅ 응답: ${response}`);
    console.log(`✅ 사용된 도구: ${toolNames.join(", ")}`);
  }, 120000);
});
