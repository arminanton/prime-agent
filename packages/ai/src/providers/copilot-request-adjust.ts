/**
 * Adjust-and-retry rules for GitHub Copilot 400 responses that name a fixable
 * request field. One adjustment, one retry, never a loop. Both wrapper shapes
 * are handled: vendor-side `{"type":"error","error":{"type","message"}}` and
 * CAPI-side `{"error":{"message","code"}}`; the caller passes the flattened text.
 */

export type CopilotRequestAdjustment =
	| { kind: "invalid_reasoning_effort"; supported: string[] }
	| { kind: "unsupported_parameter"; parameter: string }
	| { kind: "thinking_type_adaptive" };

// The effort value may arrive JSON-escaped (\"max\") when the caller passes the raw body text.
const INVALID_EFFORT_PATTERN =
	/reasoning_effort\s+\\?"([^"\\]+)\\?"\s+is not supported by model\s+\S+;\s*supported values:\s*\[([^\]]*)\]/i;
const UNSUPPORTED_PARAMETER_PATTERN = /Unsupported parameter:\s*'([A-Za-z_.]+)'/i;
const THINKING_ENABLED_PATTERN = /thinking\.type\.enabled is not supported for this model/i;

/** Classify a Copilot 400 body/message into an adjustment the caller can apply once. */
export function classifyCopilotRequestError(message: string | undefined): CopilotRequestAdjustment | undefined {
	if (!message) return undefined;
	const effort = INVALID_EFFORT_PATTERN.exec(message);
	if (effort) {
		const supported = effort[2]
			.split(/[\s,]+/)
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
		return { kind: "invalid_reasoning_effort", supported };
	}
	const parameter = UNSUPPORTED_PARAMETER_PATTERN.exec(message);
	if (parameter) return { kind: "unsupported_parameter", parameter: parameter[1] };
	if (THINKING_ENABLED_PATTERN.test(message)) return { kind: "thinking_type_adaptive" };
	return undefined;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Nearest listed effort to the rejected one, preferring the closest lower level. */
export function nearestSupportedEffort(requested: string, supported: readonly string[]): string | undefined {
	if (supported.length === 0) return undefined;
	const rank = (value: string) => EFFORT_ORDER.indexOf(value as (typeof EFFORT_ORDER)[number]);
	const target = rank(requested);
	const ranked = supported.filter((value) => rank(value) >= 0).sort((left, right) => rank(left) - rank(right));
	if (ranked.length === 0) return supported[0];
	if (target < 0) return ranked[ranked.length - 1];
	const lower = ranked.filter((value) => rank(value) <= target);
	return lower.length > 0 ? lower[lower.length - 1] : ranked[0];
}

/**
 * Apply an adjustment to a JSON request body. Returns the adjusted copy, or
 * undefined when the adjustment does not change anything (so the caller must
 * not retry an identical request).
 */
export function applyCopilotRequestAdjustment<T extends Record<string, unknown>>(
	params: T,
	adjustment: CopilotRequestAdjustment,
): T | undefined {
	switch (adjustment.kind) {
		case "invalid_reasoning_effort": {
			const current =
				typeof params.reasoning_effort === "string"
					? params.reasoning_effort
					: typeof (params.reasoning as { effort?: unknown } | undefined)?.effort === "string"
						? ((params.reasoning as { effort: string }).effort as string)
						: undefined;
			if (!current) return undefined;
			const next = nearestSupportedEffort(current, adjustment.supported);
			if (!next || next === current) return undefined;
			if (typeof params.reasoning_effort === "string") return { ...params, reasoning_effort: next };
			return { ...params, reasoning: { ...(params.reasoning as Record<string, unknown>), effort: next } };
		}
		case "unsupported_parameter": {
			if (!(adjustment.parameter in params)) return undefined;
			const { [adjustment.parameter]: _dropped, ...rest } = params;
			return rest as T;
		}
		case "thinking_type_adaptive": {
			const thinking = params.thinking as { type?: unknown; display?: unknown } | undefined;
			if (!thinking || thinking.type !== "enabled") return undefined;
			return {
				...params,
				thinking: { type: "adaptive", ...(thinking.display !== undefined ? { display: thinking.display } : {}) },
			};
		}
	}
}

/** True for an HTTP 400 from a Copilot host; other statuses are never adjusted. */
export function isAdjustableCopilotError(error: unknown): boolean {
	return (error as { status?: unknown } | undefined)?.status === 400;
}
