import { describe, expect, it } from "vitest";
import {
	knownCopilotClaudeOutputCap,
	parseCopilotOutputCapError,
	rememberCopilotClaudeOutputCap,
	resetCopilotClaudeOutputCaps,
	resolveCopilotClaudeMaxTokens,
} from "../src/providers/copilot-output-caps.js";
import type { Model } from "../src/types.js";

function copilotModel(id: string, overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxInputTokens: 936_000,
		maxTokens: 64_000,
		...overrides,
	};
}

describe("Copilot Claude output caps", () => {
	it("uses the probed server caps instead of the catalog hint", () => {
		resetCopilotClaudeOutputCaps();
		expect(knownCopilotClaudeOutputCap(copilotModel("claude-fable-5.1"))).toBe(128_000);
		expect(knownCopilotClaudeOutputCap(copilotModel("claude-opus-4.8-fast"))).toBe(128_000);
		expect(knownCopilotClaudeOutputCap(copilotModel("claude-sonnet-5"))).toBe(128_000);
		expect(knownCopilotClaudeOutputCap(copilotModel("claude-haiku-4.5"))).toBe(64_000);
		expect(knownCopilotClaudeOutputCap(copilotModel("gpt-5.6-sol", { provider: "github-copilot" }))).toBeUndefined();
		expect(knownCopilotClaudeOutputCap(copilotModel("claude-opus-4.8", { provider: "anthropic" }))).toBeUndefined();
	});

	it("clamps max_tokens so prompt plus output stays inside the context window", () => {
		resetCopilotClaudeOutputCaps();
		const model = copilotModel("claude-fable-5.1");
		expect(resolveCopilotClaudeMaxTokens(model, 10_000)).toBe(128_000);
		expect(resolveCopilotClaudeMaxTokens(model, 900_000)).toBe(1_000_000 - 900_000 - 4_096);
		expect(resolveCopilotClaudeMaxTokens(model, 999_000)).toBe(1_024);
		expect(
			resolveCopilotClaudeMaxTokens(copilotModel("claude-opus-4.8", { provider: "anthropic" }), 0),
		).toBeUndefined();
	});

	it("parses the server cap out of the 400 text and remembers it per model", () => {
		resetCopilotClaudeOutputCaps();
		const text =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-fable-5-1"}}';
		expect(parseCopilotOutputCapError(text)).toBe(128_000);
		expect(parseCopilotOutputCapError("prompt is too long: 1000759 tokens > 1000000 maximum")).toBeUndefined();
		const model = copilotModel("claude-new-model");
		expect(knownCopilotClaudeOutputCap(model)).toBeUndefined();
		expect(resolveCopilotClaudeMaxTokens(model, 0)).toBe(64_000);
		rememberCopilotClaudeOutputCap(model, 96_000);
		expect(knownCopilotClaudeOutputCap(model)).toBe(96_000);
		expect(resolveCopilotClaudeMaxTokens(model, 0)).toBe(96_000);
		resetCopilotClaudeOutputCaps();
	});
});
