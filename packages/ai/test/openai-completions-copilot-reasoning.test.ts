import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);

	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		const match = headers.find(([key]) => key?.toLowerCase() === lowerName);
		return match?.[1] ?? null;
	}

	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

/**
 * Copilot routes Gemini / grok / kimi through the OpenAI completions API. These
 * models run reasoning server-side but only return the opaque encrypted handle
 * unless the request asks for a summary, so the provider must send a nested
 * reasoning object for the visible reasoning_text to stream. See
 * providers/openai-completions.ts (the github-copilot reasoning branch).
 */
async function capturePayload(
	modelProvider: "github-copilot",
	modelId: string,
	options: Parameters<typeof streamOpenAICompletions>[2],
	onHeaders?: (headers: CapturedHeaders) => void,
): Promise<Record<string, unknown>> {
	const model = getModel(modelProvider, modelId as never);
	let captured: Record<string, unknown> = {};

	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		onHeaders?.(init?.headers as CapturedHeaders);
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAICompletions(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{
			apiKey: "test-key",
			...options,
			onPayload: (payload) => {
				captured = payload as Record<string, unknown>;
			},
		},
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("Copilot completions reasoning", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the OpenAI intent and removes the stale plugin header", async () => {
		let headers: CapturedHeaders;
		await capturePayload("github-copilot", "gemini-3.5-flash", { reasoningEnabled: false }, (value) => {
			headers = value;
		});

		expect(getHeader(headers, "Openai-Intent")).toBe("conversation-agent");
		expect(getHeader(headers, "Editor-Plugin-Version")).toBeNull();
	});

	it("requests a detailed reasoning summary for a reasoning Gemini model", async () => {
		const payload = await capturePayload("github-copilot", "gemini-3.5-flash", {});
		expect(payload.reasoning).toMatchObject({ summary: "detailed" });
		// A default effort is sent so reasoning is actually engaged.
		expect((payload.reasoning as Record<string, unknown>).effort).toBeTruthy();
	});

	it("honors an explicit reasoning effort when the catalog maps it", async () => {
		const payload = await capturePayload("github-copilot", "gemini-3.5-flash", {
			reasoningEffort: "high",
		});
		expect(payload.reasoning).toMatchObject({ effort: "high", summary: "detailed" });
	});

	it("does not send an explicitly unsupported Kimi effort", async () => {
		const payload = await capturePayload("github-copilot", "kimi-k3", {
			reasoningEffort: "medium",
		});
		expect(payload.reasoning).toEqual({ summary: "detailed" });
	});

	it("omits the reasoning object when reasoning is explicitly disabled", async () => {
		const payload = await capturePayload("github-copilot", "gemini-3.5-flash", {
			reasoningEnabled: false,
		});
		expect(payload.reasoning).toBeUndefined();
	});
});
