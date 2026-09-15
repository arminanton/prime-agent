import { describe, expect, it } from "vitest";
import {
	knownCopilotClaudeOutputCap,
	parseCopilotCombinedLimitError,
	parseCopilotOutputCapError,
	reducedMaxTokensForCombinedLimit,
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

	it("returns the probed cap without a context-window pre-clamp (no false collapse on large contexts)", () => {
		resetCopilotClaudeOutputCaps();
		const model = copilotModel("claude-fable-5.1");
		// A near-full context must NOT collapse max_tokens; the server + combined-limit retry handle overflow.
		expect(resolveCopilotClaudeMaxTokens(model)).toBe(128_000);
		// haiku probed cap
		expect(resolveCopilotClaudeMaxTokens(copilotModel("claude-haiku-4.5"))).toBe(64_000);
		// non-Copilot models keep the caller default
		expect(resolveCopilotClaudeMaxTokens(copilotModel("claude-opus-4.8", { provider: "anthropic" }))).toBeUndefined();
	});

	it("parses the server cap out of the 400 text and remembers it per model", () => {
		resetCopilotClaudeOutputCaps();
		const text =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-fable-5-1"}}';
		expect(parseCopilotOutputCapError(text)).toBe(128_000);
		expect(parseCopilotOutputCapError("prompt is too long: 1000759 tokens > 1000000 maximum")).toBeUndefined();
		const model = copilotModel("claude-new-model");
		expect(knownCopilotClaudeOutputCap(model)).toBeUndefined();
		expect(resolveCopilotClaudeMaxTokens(model)).toBe(64_000);
		rememberCopilotClaudeOutputCap(model, 96_000);
		expect(knownCopilotClaudeOutputCap(model)).toBe(96_000);
		expect(resolveCopilotClaudeMaxTokens(model)).toBe(96_000);
		resetCopilotClaudeOutputCaps();
	});
});

describe("Copilot combined prompt+max_tokens limit", () => {
	it("parses the combined-limit 400 and reduces max_tokens to fit", () => {
		const text =
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"input length and `max_tokens` exceed context limit: 190000 + 128000 > 200000, decrease input length or `max_tokens` and try again"}}';
		const parsed = parseCopilotCombinedLimitError(text);
		expect(parsed).toEqual({ input: 190_000, maxTokens: 128_000, limit: 200_000 });
		// room = 200000 - 190000 - 4096 = 5904, below the requested 128000 -> reduce.
		expect(reducedMaxTokensForCombinedLimit(parsed!)).toBe(5_904);
	});

	it("returns undefined for a true overflow (no room for output)", () => {
		expect(reducedMaxTokensForCombinedLimit({ input: 199_900, maxTokens: 4_000, limit: 200_000 })).toBeUndefined();
	});

	it("does not match the plain output-cap rejection", () => {
		expect(
			parseCopilotCombinedLimitError(
				"max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens",
			),
		).toBeUndefined();
	});
});
