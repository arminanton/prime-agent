import type { Model } from "../types.js";

/**
 * Output-token caps for Claude models served through GitHub Copilot.
 *
 * The Copilot `/models` catalog advertises `max_output_tokens` as a client hint
 * (64000 for opus/sonnet/fable) that the server does not enforce. The real
 * request-time ceiling is enforced by Anthropic behind Copilot and rejected with
 * a 400 whose text names the cap:
 *   `max_tokens: 128001 > 128000, which is the maximum allowed number of output tokens for claude-opus-4-8`
 * Probed 2026-09-15: opus-4.7/4.8/4.8-fast/5, sonnet-5, fable-5/5.1 -> 128000;
 * haiku-4.5 -> 64000. Beta headers do not lift these caps.
 */
const COPILOT_CLAUDE_OUTPUT_CAPS: ReadonlyArray<{ pattern: RegExp; cap: number }> = [
	{ pattern: /haiku/i, cap: 64_000 },
	{ pattern: /^claude-(opus|sonnet|fable|mythos)/i, cap: 128_000 },
];

const learnedOutputCaps = new Map<string, number>();

function capKey(model: Pick<Model<any>, "provider" | "id" | "baseUrl">): string {
	return `${model.baseUrl}\0${model.id}`;
}

/** Known server output cap for a Copilot Claude model, or undefined when unprobed. */
export function knownCopilotClaudeOutputCap(
	model: Pick<Model<any>, "provider" | "id" | "baseUrl">,
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
	model: Pick<Model<any>, "provider" | "id" | "baseUrl">,
	cap: number,
): void {
	if (Number.isFinite(cap) && cap > 0) learnedOutputCaps.set(capKey(model), Math.floor(cap));
}

/** Test hook. */
export function resetCopilotClaudeOutputCaps(): void {
	learnedOutputCaps.clear();
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
	if (room < MIN_OUTPUT_TOKENS) return undefined;
	return Math.min(limit.maxTokens - 1, room);
}

/**
 * Nominal token cost charged per image content block. Anthropic caps an image at
 * roughly (1568x1568)/750 ~= 1600 tokens, so 1600 is a safe generous ceiling. The
 * base64 `data` field itself is NEVER counted: at chars/4 a single screenshot would
 * add 75K-250K phantom tokens and collapse the clamped max_tokens to its floor.
 */
/**
 * Resolve `max_tokens` for a Copilot Claude request: the probed server output cap
 * (128K opus/sonnet/fable, 64K haiku), or the catalog value when unprobed. Returns
 * undefined for non-Copilot models so the caller keeps its default.
 *
 * No context-window pre-clamp: a rough prompt-token estimate systematically
 * over-counts dense code/JSON/image contexts (a ~798K-token prompt estimated near
 * ~1M collapsed max_tokens to the floor and truncated every turn). The server
 * enforces `prompt + max_tokens <= context`, and `createWithOutputCapRetry` reacts
 * to the "input length and max_tokens exceed context limit" 400 by reducing
 * max_tokens to fit, so the proactive clamp is redundant and only caused false
 * collapses on large sessions.
 */
export function resolveCopilotClaudeMaxTokens(model: Model<any>): number | undefined {
	const cap = knownCopilotClaudeOutputCap(model) ?? model.maxTokens;
	if (model.provider !== "github-copilot" || !cap) return undefined;
	return cap;
}
