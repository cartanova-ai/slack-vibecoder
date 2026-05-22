import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { queryInteractive } from "./claude-interactive";

const CLAUDE_PATH = "/Users/potados/.local/bin/claude";

interface PrintModeResult {
	assistantTexts: string[];
	toolUses: string[];
	resultText: string;
}

interface InteractiveResult {
	progressTexts: string[];
	textEvents: string[];
	toolUses: string[];
	resultText: string;
}

async function runPrintMode(prompt: string): Promise<PrintModeResult> {
	return new Promise((resolve) => {
		const assistantTexts: string[] = [];
		const toolUses: string[] = [];
		let resultText = "";

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
						if (block.type === "text" && block.text) assistantTexts.push(block.text);
						if (block.type === "tool_use") toolUses.push(block.name);
					}
				}
				if (msg.type === "result") resultText = msg.result ?? "";
			} catch {}
		});

		proc.on("exit", () => resolve({ assistantTexts, toolUses, resultText }));
	});
}

async function runInteractive(prompt: string): Promise<InteractiveResult> {
	const progressTexts: string[] = [];
	const textEvents: string[] = [];
	const toolUses: string[] = [];
	let resultText = "";

	for await (const event of queryInteractive(prompt, { cwd: process.cwd() })) {
		switch (event.type) {
			case "tool_use": toolUses.push(event.name); break;
			case "progress": progressTexts.push(event.text); break;
			case "text": textEvents.push(event.text); break;
			case "result": resultText = event.text; break;
		}
	}

	return { progressTexts, textEvents, toolUses, resultText };
}

describe("claude -p 동등성 테스트", () => {
	it("간단한 질문: text 1회, result와 동일", async () => {
		const i = await runInteractive("1+1은 몇이야? 숫자만 답해.");

		// text 이벤트 정확히 1회
		expect(i.textEvents).toHaveLength(1);
		// progress는 없어야 함 (도구 안 씀)
		expect(i.progressTexts).toHaveLength(0);
		// result 텍스트가 text 이벤트와 동일
		expect(i.resultText).toBe(i.textEvents[0]);
		// 내용 확인
		expect(i.resultText).toContain("2");
	}, 60000);

	it("도구 사용(Read): text 이벤트가 전체 응답이고 result와 동일", async () => {
		const prompt = "이 프로젝트의 package.json을 읽어서 프로젝트 이름만 알려줘. 이름만.";
		const i = await runInteractive(prompt);

		// 도구 사용
		expect(i.toolUses.length).toBeGreaterThan(0);
		// text 이벤트 1회 (end_turn에서만)
		expect(i.textEvents).toHaveLength(1);
		// result와 text가 동일 (조각이 아님을 증명)
		expect(i.resultText).toBe(i.textEvents[0]);
		// 내용 확인
		expect(i.resultText.toLowerCase()).toContain("slack-vibecoder");
		// 중간 말이 결과에 없음
		expect(i.resultText).not.toMatch(/읽어보겠|확인하겠|찾아보겠/);

		console.log(`  도구: ${i.toolUses.join(", ")}, 결과: ${i.resultText.length}자`);
	}, 120000);

	it("웹 검색: result가 완전한 응답 (claude -p와 길이 비교)", async () => {
		const prompt = "오늘 서울 날씨를 WebSearch 도구로 검색해줘";
		const [p, i] = await Promise.all([
			runPrintMode(prompt),
			runInteractive(prompt),
		]);

		// text 이벤트 1회 (end_turn에서만)
		expect(i.textEvents).toHaveLength(1);
		// result와 text가 동일
		expect(i.resultText).toBe(i.textEvents[0]);
		// 중간 말이 결과에 없음
		expect(i.resultText).not.toMatch(/검색.*하겠|찾아.*보겠|확인해.*볼게/);
		// 마크다운 리스트가 깨지지 않음 (- 뒤에 줄바꿈 + 내용이 아닌, - 뒤에 바로 내용)
		const brokenList = i.resultText.match(/^- *\n[^\n-]/m);
		expect(brokenList).toBeNull();

		// -p와 길이 비교 (인터랙티브가 더 상세할 수 있지만 30% 이상은 되어야 함)
		expect(i.resultText.length).toBeGreaterThan(p.resultText.length * 0.3);

		console.log(`  -p: ${p.resultText.length}자, interactive: ${i.resultText.length}자`);
		console.log(`  -p result 일부: "${p.resultText.slice(0, 80)}..."`);
		console.log(`  interactive result 일부: "${i.resultText.slice(0, 80)}..."`);
	}, 180000);
});
