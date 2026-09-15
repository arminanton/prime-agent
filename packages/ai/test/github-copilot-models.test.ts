import { describe, expect, it } from "vitest";
import { getModels, getSupportedThinkingLevels } from "../src/models.js";
import type { Api, Model, ModelThinkingLevel } from "../src/types.js";

function getCopilotModel(id: string): Model<Api> {
	const model = getModels("github-copilot").find((candidate) => candidate.id === id);
	expect(model, `missing github-copilot model ${id}`).toBeDefined();
	return model as Model<Api>;
}

describe("GitHub Copilot model catalog", () => {
	it("includes current source-backed models without dropping uncertain fallback entries", () => {
		const ids = getModels("github-copilot").map((model) => model.id);

		expect(ids).toEqual(
			expect.arrayContaining(["claude-fable-5.1", "claude-opus-4.8-fast", "gemini-3.8-flash", "gpt-6-astra"]),
		);
		// Built-in lists and one account's live catalog are not global entitlement truth.
		expect(ids).toEqual(
			expect.arrayContaining([
				"claude-opus-4.5",
				"gemini-2.5-pro",
				"gemini-3-pro-preview",
				"gemini-3.1-pro-preview",
				"gpt-5.2",
			]),
		);
	});

	it.each([
		["claude-fable-5.1", "anthropic-messages"],
		["claude-opus-4.8-fast", "anthropic-messages"],
		["gemini-2.5-pro", "openai-completions"],
		["gemini-3-pro-preview", "openai-completions"],
		["gemini-3.8-flash", "openai-completions"],
		["gpt-6-astra", "openai-responses"],
		["mai-code-1-flash-picker", "openai-responses"],
		["mai-code-1.1-flash", "openai-responses"],
	] as const)("routes %s through %s", (id, api) => {
		expect(getCopilotModel(id).api).toBe(api);
	});

	it.each([
		["claude-fable-5.1", 1_000_000, 872_000, 128_000],
		["claude-opus-4.5", 200_000, 168_000, 32_000],
		["claude-opus-4.6", 200_000, 168_000, 32_000],
		["claude-opus-4.7", 1_000_000, 936_000, 64_000],
		["claude-opus-4.8", 1_000_000, 936_000, 64_000],
		["claude-opus-4.8-fast", 1_000_000, 936_000, 64_000],
		["claude-opus-5", 1_000_000, 936_000, 64_000],
		["claude-sonnet-4.5", 200_000, 168_000, 32_000],
		["claude-sonnet-5", 1_000_000, 936_000, 64_000],
		["gemini-3.5-flash", 1_000_000, 936_000, 64_000],
		["gemini-3.6-flash", 1_000_000, 936_000, 64_000],
		["gemini-3.7-flash", 1_000_000, 936_000, 64_000],
		["gemini-3.8-flash", 1_048_576, 983_040, 65_536],
		["gpt-4.1", 128_000, 64_000, 16_384],
		["gpt-5.2", 400_000, 272_000, 128_000],
		["gpt-5.3-codex", 400_000, 272_000, 128_000],
		["gpt-5.4-mini", 400_000, 272_000, 128_000],
		["gpt-5.4", 1_050_000, 922_000, 128_000],
		["gpt-5.5", 1_050_000, 922_000, 128_000],
		["gpt-5.6-luna", 1_050_000, 922_000, 128_000],
		["gpt-5.6-sol", 1_050_000, 922_000, 128_000],
		["gpt-5.6-terra", 1_050_000, 922_000, 128_000],
		["gpt-6-astra", 1_000_000, 872_000, 128_000],
		["grok-4.5", 500_000, 372_000, 128_000],
		["grok-4.6", 500_000, 372_000, 128_000],
		["mai-code-1-flash-picker", 256_000, 128_000, 128_000],
		["mai-code-1.1-flash", 256_000, 128_000, 128_000],
		["gpt-5-mini", 264_000, 128_000, 64_000],
		["claude-haiku-4.5", 200_000, 136_000, 64_000],
	] as const)("uses the live capability limits for %s", (id, contextWindow, maxInputTokens, maxTokens) => {
		expect(getCopilotModel(id)).toMatchObject({ contextWindow, maxInputTokens, maxTokens });
	});

	it.each<[string, ModelThinkingLevel[]]>([
		["claude-fable-5.1", ["low", "medium", "high", "xhigh", "max"]],
		["claude-opus-4.8-fast", ["low", "medium", "high", "xhigh", "max"]],
		["gemini-3.5-flash", ["minimal", "low", "medium", "high"]],
		["gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
		["gemini-3.7-flash", ["low", "medium", "high"]],
		["gemini-3.8-flash", ["low", "medium", "high"]],
		["gpt-5.4", ["off", "low", "medium", "high", "xhigh"]],
		["gpt-5.4-nano", ["off", "low", "medium", "high", "xhigh"]],
		["gpt-5.6-sol", ["off", "low", "medium", "high", "xhigh", "max"]],
		["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
		["grok-4.5", ["low", "medium", "high"]],
		["grok-4.6", ["low", "medium", "high", "xhigh"]],
		["mai-code-1.1-flash", ["low", "medium", "high"]],
	])("exposes only the advertised thinking levels for %s", (id, levels) => {
		expect(getSupportedThinkingLevels(getCopilotModel(id))).toEqual(levels);
	});

	it("defines a prompt cap for every static Copilot fallback", () => {
		for (const model of getModels("github-copilot")) {
			expect(model.maxInputTokens, model.id).toBeTypeOf("number");
			expect(model.maxInputTokens, model.id).toBeLessThanOrEqual(model.contextWindow);
		}
	});

	it("uses the current CLI identity in every static fallback", () => {
		for (const model of getModels("github-copilot")) {
			expect(model.headers).toEqual({
				"User-Agent": "copilot/1.0.84-5",
				"Editor-Version": "copilot/1.0.84-5",
				"Copilot-Integration-Id": "copilot-developer-cli",
			});
		}
	});
});
