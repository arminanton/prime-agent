import type { Api, Model } from "../types.js";

// Observed Anthropic output caps behind Copilot (2026-09-15). The catalog's
// max_output_tokens can be lower; it is not always the server-enforced cap.
const COPILOT_CLAUDE_OUTPUT_CAPS: ReadonlyArray<{ pattern: RegExp; cap: number }> = [
	{ pattern: /haiku/i, cap: 64_000 },
	{ pattern: /^claude-(opus|sonnet|fable|mythos)/i, cap: 128_000 },
];

const learnedOutputCaps = new Map<string, number>();

function capKey(model: Pick<Model<Api>, "provider" | "id" | "baseUrl">): string {
	return `${model.baseUrl}\0${model.id}`;
}

/** Known server output cap for a Copilot Claude model, or undefined when unprobed. */
export function knownCopilotClaudeOutputCap(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl">,
): number | undefined {
	if (model.provider !== "github-copilot") return undefined;
	const learned = learnedOutputCaps.get(capKey(model));
	if (learned !== undefined) return learned;
	for (const { pattern, cap } of COPILOT_CLAUDE_OUTPUT_CAPS) {
		if (pattern.test(model.id)) return cap;
	}
	return undefined;
}

/** Remember a cap the server reported for this model on this host. */
export function rememberCopilotClaudeOutputCap(
	model: Pick<Model<Api>, "provider" | "id" | "baseUrl">,
	cap: number,
): void {
	if (!Number.isFinite(cap) || cap <= 0) return;
	const key = capKey(model);
	if (!learnedOutputCaps.has(key) && learnedOutputCaps.size >= 512) {
		const oldest = learnedOutputCaps.keys().next().value;
		if (oldest !== undefined) learnedOutputCaps.delete(oldest);
	}
	learnedOutputCaps.set(key, Math.floor(cap));
}

const COMBINED_LIMIT_MARGIN_TOKENS = 4_096;
const MIN_OUTPUT_TOKENS = 1_024;

const CAP_ERROR_PATTERN = /max_tokens:\s*(\d+)\s*>\s*(\d+),\s*which is the maximum allowed number of output tokens/i;

/** Extract the server cap from an Anthropic max_tokens rejection, if the message is one. */
export function parseCopilotOutputCapError(message: string | undefined): number | undefined {
	if (!message) return undefined;
	const match = CAP_ERROR_PATTERN.exec(message);
	if (!match) return undefined;
	const cap = Number(match[2]);
	return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

// Anthropic rejects a request whose prompt + max_tokens exceeds the model context
// with e.g. "input length and `max_tokens` exceed context limit: 190000 + 128000 >
// 200000, decrease input length or `max_tokens` and try again". This is distinct
// from the per-model output cap above and is not an overflow (the prompt alone fits).
const COMBINED_LIMIT_ERROR_PATTERN =
	/input length and\s+`?max_tokens`?\s+exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i;

export interface CopilotCombinedLimit {
	input: number;
	maxTokens: number;
	limit: number;
}

/** Parse an Anthropic combined prompt+max_tokens context-limit rejection. */
export function parseCopilotCombinedLimitError(message: string | undefined): CopilotCombinedLimit | undefined {
	if (!message) return undefined;
	const match = COMBINED_LIMIT_ERROR_PATTERN.exec(message);
	if (!match) return undefined;
	const input = Number(match[1]);
	const maxTokens = Number(match[2]);
	const limit = Number(match[3]);
	if (![input, maxTokens, limit].every((value) => Number.isFinite(value) && value >= 0)) return undefined;
	return { input, maxTokens, limit };
}

/**
 * Given a server-reported combined-limit rejection, the reduced max_tokens that
 * keeps input + max_tokens under the reported context limit, or undefined when no
 * positive room remains (a true overflow the caller must surface).
 */
export function reducedMaxTokensForCombinedLimit(limit: CopilotCombinedLimit): number | undefined {
	const room = limit.limit - limit.input - COMBINED_LIMIT_MARGIN_TOKENS;
	const reduced = Math.min(limit.maxTokens - 1, room);
	return reduced >= MIN_OUTPUT_TOKENS ? reduced : undefined;
}

// Do not pre-clamp against a rough prompt estimate. Dense code and image data
// overestimate input size and collapse the output budget. Retry using the
// server's token counts when it rejects the combined input and output budget.
export function resolveCopilotClaudeMaxTokens(model: Model<Api>): number | undefined {
	const cap = knownCopilotClaudeOutputCap(model) ?? model.maxTokens;
	if (model.provider !== "github-copilot" || !cap) return undefined;
	return cap;
}
