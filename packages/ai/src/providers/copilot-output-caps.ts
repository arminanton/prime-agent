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

const CAP_ERROR_PATTERN = /max_tokens:\s*(\d+)\s*>\s*(\d+),\s*which is the maximum allowed number of output tokens/i;

/** Extract the server cap from an Anthropic max_tokens rejection, if the message is one. */
export function parseCopilotOutputCapError(message: string | undefined): number | undefined {
	if (!message) return undefined;
	const match = CAP_ERROR_PATTERN.exec(message);
	if (!match) return undefined;
	const cap = Number(match[2]);
	return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}

/** Rough token estimate for the combined prompt+output validation (chars/4, generous). */
export function estimatePromptTokens(context: {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
}): number {
	let chars = context.systemPrompt?.length ?? 0;
	try {
		chars += JSON.stringify(context.messages).length;
		if (context.tools) chars += JSON.stringify(context.tools).length;
	} catch {
		return 0;
	}
	return Math.ceil(chars / 4);
}

const COMBINED_LIMIT_MARGIN_TOKENS = 4_096;
const MIN_OUTPUT_TOKENS = 1_024;

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
