import { describe, expect, it } from "vitest";
import {
	applyCopilotRequestAdjustment,
	classifyCopilotRequestError,
	isAdjustableCopilotError,
	nearestSupportedEffort,
} from "../src/providers/copilot-request-adjust.js";

describe("Copilot request adjustments", () => {
	it("classifies the CAPI invalid_reasoning_effort shape and picks the nearest listed effort", () => {
		const message =
			'400 {"error":{"message":"reasoning_effort \\"max\\" is not supported by model gemini-3.8-flash; supported values: [low medium high]","code":"invalid_reasoning_effort"}}';
		const adjustment = classifyCopilotRequestError(message);
		expect(adjustment).toEqual({ kind: "invalid_reasoning_effort", supported: ["low", "medium", "high"] });
		expect(nearestSupportedEffort("max", ["low", "medium", "high"])).toBe("high");
		expect(nearestSupportedEffort("minimal", ["low", "medium", "high"])).toBe("low");
		expect(nearestSupportedEffort("medium", ["low", "high"])).toBe("low");
		const adjusted = applyCopilotRequestAdjustment(
			{ model: "gemini-3.8-flash", reasoning_effort: "max" },
			adjustment!,
		);
		expect(adjusted).toEqual({ model: "gemini-3.8-flash", reasoning_effort: "high" });
		const nested = applyCopilotRequestAdjustment(
			{ model: "gpt-6-astra", reasoning: { effort: "max", summary: "auto" } },
			adjustment!,
		);
		expect(nested).toEqual({ model: "gpt-6-astra", reasoning: { effort: "high", summary: "auto" } });
	});

	it("drops an unsupported /responses sampling parameter once", () => {
		const adjustment = classifyCopilotRequestError(
			"400 Unsupported parameter: 'temperature' is not supported with this model.",
		);
		expect(adjustment).toEqual({ kind: "unsupported_parameter", parameter: "temperature" });
		expect(applyCopilotRequestAdjustment({ model: "gpt-5.6-sol", temperature: 1 }, adjustment!)).toEqual({
			model: "gpt-5.6-sol",
		});
		expect(applyCopilotRequestAdjustment({ model: "gpt-5.6-sol" }, adjustment!)).toBeUndefined();
	});

	it("switches manual thinking to adaptive when the vendor rejects thinking.type.enabled", () => {
		const adjustment = classifyCopilotRequestError(
			'400 {"type":"error","error":{"type":"invalid_request_error","message":"thinking.type.enabled is not supported for this model. Use thinking.type.adaptive and output_config.effort"},"request_id":"req_1"}',
		);
		expect(adjustment).toEqual({ kind: "thinking_type_adaptive" });
		expect(
			applyCopilotRequestAdjustment(
				{ model: "claude-opus-4.8", thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" } },
				adjustment!,
			),
		).toEqual({ model: "claude-opus-4.8", thinking: { type: "adaptive", display: "summarized" } });
		expect(
			applyCopilotRequestAdjustment({ model: "claude-opus-4.8", thinking: { type: "adaptive" } }, adjustment!),
		).toBeUndefined();
	});

	it("never adjusts non-400 errors or unknown 400 texts", () => {
		expect(isAdjustableCopilotError({ status: 429 })).toBe(false);
		expect(isAdjustableCopilotError({ status: 400 })).toBe(true);
		expect(classifyCopilotRequestError("Bad Request")).toBeUndefined();
		expect(classifyCopilotRequestError("prompt token count of 386366 exceeds the limit of 372000")).toBeUndefined();
	});
});
