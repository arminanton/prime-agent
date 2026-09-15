import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Model } from "../src/types.js";

const geminiNonStreaming: Model<"openai-completions"> = {
	id: "gemini-3.8-flash",
	name: "Gemini 3.8 Flash",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.githubcopilot.com",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxInputTokens: 983_040,
	maxTokens: 200_000,
	compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, nonStreaming: true },
};

describe("Copilot non-streaming completions", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends stream:false and replays the whole response through the streaming parser", async () => {
		let requestBody: Record<string, unknown> = {};
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion",
					created: 1,
					model: "gemini-3.8-flash",
					choices: [
						{
							index: 0,
							finish_reason: "tool_calls",
							message: {
								role: "assistant",
								content: null,
								reasoning_text: "Full trailing reasoning segment.",
								reasoning_opaque: "OPAQUE",
								tool_calls: [
									{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"value":"x"}' } },
								],
							},
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const stream = streamOpenAICompletions(
			geminiNonStreaming,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{
						name: "echo",
						description: "Echo",
						parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
					},
				],
			},
			{ apiKey: "test-key" },
		);
		const types: string[] = [];
		let done: Record<string, unknown> | undefined;
		for await (const event of stream) {
			types.push(event.type);
			if (event.type === "done") done = event as unknown as Record<string, unknown>;
			if (event.type === "done" || event.type === "error") break;
		}

		expect(requestBody.stream).toBe(false);
		expect(requestBody.stream_options).toBeUndefined();
		expect(requestBody.reasoning_effort).toBe("high");
		expect(types).toContain("thinking_delta");
		expect(types).toContain("toolcall_end");
		const message = done?.message as {
			content: Array<Record<string, unknown>>;
			usage: { input: number; output: number };
		};
		const thinking = message.content.find((block) => block.type === "thinking");
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(thinking?.thinking).toBe("Full trailing reasoning segment.");
		expect(toolCall?.thoughtSignature).toBe("copilot-reasoning-opaque:OPAQUE");
		expect(message.usage.input).toBe(10);
		expect(message.usage.output).toBe(5);
	});
});
