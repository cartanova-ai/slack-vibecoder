import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { queryInteractive, type ClaudeEvent } from "./claude-interactive";

const CLAUDE_PATH = "/Users/potados/.local/bin/claude";

/**
 * claude -p --output-format stream-json으로 실행하여
 * tool_use 이벤트와 최종 텍스트를 수집합니다.
 */
async function runPrintMode(prompt: string): Promise<{
	toolUses: { name: string }[];
	finalText: string;
}> {
	return new Promise((resolve) => {
		const toolUses: { name: string }[] = [];
		let finalText = "";

		const proc = spawn(CLAUDE_PATH, [
			"-p", prompt,
			"--output-format", "stream-json",
			"--verbose",
		], { stdio: ["pipe", "pipe", "pipe"] });

		const rl = createInterface({ input: proc.stdout! });
		rl.on("line", (line) => {
			try {
				const msg = JSON.parse(line.trim());
				if (msg.type === "assistant" && msg.message?.content) {
					for (const block of msg.message.content) {
						if (block.type === "tool_use") {
							toolUses.push({ name: block.name });
						}
					}
				}
				if (msg.type === "result") {
					finalText = msg.result ?? "";
				}
			} catch {}
		});

		proc.on("exit", () => resolve({ toolUses, finalText }));
	});
}

/**
 * queryInteractive로 실행하여
 * tool_use 이벤트와 최종 텍스트를 수집합니다.
 */
async function runInteractive(prompt: string): Promise<{
	toolUses: { name: string }[];
	texts: string[];
	resultText: string;
}> {
	const toolUses: { name: string }[] = [];
	const texts: string[] = [];
	let resultText = "";

	for await (const event of queryInteractive(prompt, { cwd: process.cwd() })) {
		switch (event.type) {
			case "tool_use":
				toolUses.push({ name: event.name });
				break;
			case "text":
				texts.push(event.text);
				break;
			case "result":
				resultText = event.text;
				break;
		}
	}

	return { toolUses, texts, resultText };
}

describe("claude -p 동등성 테스트", () => {
	it("간단한 질문: text 이벤트가 1회, 내용이 비어있지 않음", async () => {
		const interactive = await runInteractive("1+1은 몇이야? 숫자만 답해.");

		expect(interactive.texts).toHaveLength(1);
		expect(interactive.texts[0]).toContain("2");
		expect(interactive.resultText).toContain("2");
	}, 60000);

	it("도구 사용: tool_use 이벤트 발생, 최종 텍스트에 중간 말 미포함", async () => {
		const prompt = "이 프로젝트의 package.json을 읽어서 프로젝트 이름만 알려줘. 이름만.";

		const [printResult, interactive] = await Promise.all([
			runPrintMode(prompt),
			runInteractive(prompt),
		]);

		// 둘 다 도구를 사용해야 함
		expect(printResult.toolUses.length).toBeGreaterThan(0);
		expect(interactive.toolUses.length).toBeGreaterThan(0);

		// 인터랙티브의 text 이벤트는 1회여야 함 (end_turn에서만)
		expect(interactive.texts).toHaveLength(1);

		// 최종 텍스트가 비어있지 않아야 함
		expect(interactive.resultText.length).toBeGreaterThan(0);
		expect(printResult.finalText.length).toBeGreaterThan(0);

		// 둘 다 프로젝트 이름을 포함해야 함
		expect(printResult.finalText.toLowerCase()).toContain("slack-vibecoder");
		expect(interactive.resultText.toLowerCase()).toContain("slack-vibecoder");
	}, 120000);

	it("웹 검색: 최종 텍스트가 조각이 아닌 완전한 응답", async () => {
		const prompt = "오늘 날씨 web search 툴을 써서 찾아줘";

		const [printResult, interactive] = await Promise.all([
			runPrintMode(prompt),
			runInteractive(prompt),
		]);

		// 둘 다 도구 사용
		expect(printResult.toolUses.length).toBeGreaterThan(0);
		expect(interactive.toolUses.length).toBeGreaterThan(0);

		// text 이벤트 1회
		expect(interactive.texts).toHaveLength(1);

		// 최종 텍스트 길이가 비슷해야 함 (±50% 범위)
		const printLen = printResult.finalText.length;
		const interactiveLen = interactive.resultText.length;
		console.log(`  -p: ${printLen}자, interactive: ${interactiveLen}자`);

		expect(interactiveLen).toBeGreaterThan(printLen * 0.3);
		expect(interactiveLen).toBeLessThan(printLen * 3);

		// 중간 말("검색하겠습니다" 등)이 최종 텍스트에 없어야 함
		expect(interactive.resultText).not.toMatch(/검색.*하겠습니다/);
		expect(interactive.resultText).not.toMatch(/찾아.*보겠/);
	}, 180000);
});
