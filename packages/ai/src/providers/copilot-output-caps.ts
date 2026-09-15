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
const NOMINAL_IMAGE_TOKENS = 1_600;

/** Rough token estimate for the combined prompt+output validation (chars/4, generous). */
export function estimatePromptTokens(context: {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
}): number {
	let chars = context.systemPrompt?.length ?? 0;
	let imageTokens = 0;
	const seen = new WeakSet<object>();
	const walk = (node: unknown): void => {
		if (node === null || node === undefined) return;
		const t = typeof node;
		if (t === "string") {
			chars += (node as string).length;
			return;
		}
		if (t === "number" || t === "boolean") {
			chars += String(node).length;
			return;
		}
		if (t !== "object") return;
		if (seen.has(node as object)) return;
		seen.add(node as object);
		if (Array.isArray(node)) {
			for (const el of node) walk(el);
			return;
		}
		const rec = node as Record<string, unknown>;
		// Image content blocks: charge a nominal token cost and skip base64 payloads
		// (internal `{ type: "image", data, mimeType }` and any `source: { data }`).
		if (rec.type === "image" || rec.type === "image_url" || rec.type === "input_image") {
			imageTokens += NOMINAL_IMAGE_TOKENS;
			for (const [key, value] of Object.entries(rec)) {
				if (key === "data" || key === "image_url") continue;
				if (key === "source" && value && typeof value === "object" && !Array.isArray(value)) {
					for (const [sk, sv] of Object.entries(value as Record<string, unknown>)) {
						if (sk === "data") continue;
						walk(sv);
					}
					continue;
				}
				walk(value);
			}
			return;
		}
		for (const value of Object.values(rec)) walk(value);
	};
	try {
		walk(context.messages);
		if (context.tools) walk(context.tools);
	} catch {
		return 0;
	}
	return Math.ceil(chars / 4) + imageTokens;
}

/**
 * Resolve `max_tokens` for a Copilot Claude request: the probed server cap,
 * clamped so `prompt + max_tokens` stays under the model's total context
 * (Anthropic validates the sum), never below a small floor. Returns undefined
 * for non-Copilot models so the caller keeps its default.
 */
export function resolveCopilotClaudeMaxTokens(model: Model<any>, promptTokens: number): number | undefined {
	const cap = knownCopilotClaudeOutputCap(model) ?? model.maxTokens;
	if (model.provider !== "github-copilot" || !cap) return undefined;
	const contextWindow = model.contextWindow || 0;
	if (contextWindow <= 0) return cap;
	const room = contextWindow - promptTokens - COMBINED_LIMIT_MARGIN_TOKENS;
	return Math.max(MIN_OUTPUT_TOKENS, Math.min(cap, room));
}
