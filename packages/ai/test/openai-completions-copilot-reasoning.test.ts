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
 * Copilot routes Gemini / grok / kimi through the OpenAI completions API. The
 * request body mirrors the official CLI: a top-level reasoning_effort validated
 * against the catalog, temperature 1, tool_choice "validated" when tools exist,
 * snippy disabled, and no nested reasoning object. The server streams
 * reasoning_text on its own and returns the encrypted reasoning state as
 * reasoning_opaque on the tool_calls delta; the continuation replays both.
 * See providers/openai-completions.ts (the github-copilot reasoning branch).
 */
async function capturePayload(
	modelProvider: "github-copilot",
	modelId: string,
	options: Parameters<typeof streamOpenAICompletions>[2],
	onHeaders?: (headers: CapturedHeaders) => void,
	context?: Partial<Parameters<typeof streamOpenAICompletions>[1]>,
	body = "data: [DONE]\n\n",
): Promise<{ payload: Record<string, unknown>; events: Array<Record<string, unknown>> }> {
	const model = getModel(modelProvider, modelId as never);
	let captured: Record<string, unknown> = {};

	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		onHeaders?.(init?.headers as CapturedHeaders);
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAICompletions(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			...context,
		},
		{
			apiKey: "test-key",
			...options,
			onPayload: (payload) => {
				captured = payload as Record<string, unknown>;
			},
		},
	);

	const events: Array<Record<string, unknown>> = [];
	for await (const event of stream) {
		events.push(event as unknown as Record<string, unknown>);
		if (event.type === "done" || event.type === "error") break;
	}

	return { payload: captured, events };
}

const echoTool = {
	name: "echo",
	description: "Echo a value",
	parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
};

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

	it("sends the CLI body shape with the highest catalog effort by default", async () => {
		const { payload } = await capturePayload("github-copilot", "gemini-3.5-flash", {}, undefined, {
			tools: [echoTool],
		});
		expect(payload.reasoning).toBeUndefined();
		expect(payload.reasoning_effort).toBe("high");
		expect(payload.temperature).toBe(1);
		expect(payload.tool_choice).toBe("validated");
		expect(payload.snippy).toEqual({ enabled: false });
		expect(payload.stream_options).toEqual({ include_usage: true });
	});

	it("honors an explicit reasoning effort when the catalog maps it", async () => {
		const { payload } = await capturePayload("github-copilot", "gemini-3.5-flash", {
			reasoningEffort: "low",
		});
		expect(payload.reasoning_effort).toBe("low");
		expect(payload.tool_choice).toBeUndefined();
	});

	it("omits an effort the catalog rejects instead of sending it", async () => {
		const { payload } = await capturePayload("github-copilot", "gemini-3.8-flash", {
			reasoningEffort: "max",
		});
		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.snippy).toEqual({ enabled: false });
	});

	it("omits every reasoning field when reasoning is explicitly disabled", async () => {
		const { payload } = await capturePayload("github-copilot", "gemini-3.5-flash", {
			reasoningEnabled: false,
		});
		expect(payload.reasoning).toBeUndefined();
		expect(payload.reasoning_effort).toBeUndefined();
		expect(payload.snippy).toBeUndefined();
	});

	it("captures reasoning_opaque from the tool_calls delta and replays it on the continuation", async () => {
		const opaque = "ENCRYPTED_STATE_BLOB";
		const sse = [
			`data: ${JSON.stringify({
				id: "c1",
				choices: [{ index: 0, delta: { reasoning_text: "Thinking about echo." } }],
			})}`,
			`data: ${JSON.stringify({
				id: "c1",
				choices: [
					{
						index: 0,
						delta: {
							reasoning_opaque: opaque,
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "echo", arguments: '{"value":"x"}' },
								},
							],
						},
					},
				],
			})}`,
			`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
			"data: [DONE]",
			"",
		].join("\n\n");
		const { events } = await capturePayload(
			"github-copilot",
			"gemini-3.5-flash",
			{},
			undefined,
			{ tools: [echoTool] },
			sse,
		);
		const done = events.find((event) => event.type === "done") as {
			message: { content: Array<Record<string, unknown>> };
		};
		const toolCall = done.message.content.find((block) => block.type === "toolCall") as Record<string, unknown>;
		expect(toolCall.thoughtSignature).toBe(`copilot-reasoning-opaque:${opaque}`);

		const { payload } = await capturePayload("github-copilot", "gemini-3.5-flash", {}, undefined, {
			tools: [echoTool],
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				done.message as never,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "echo",
					content: [{ type: "text", text: "x" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		});
		const replayed = (payload.messages as Array<Record<string, unknown>>).find(
			(message) => message.role === "assistant",
		)!;
		expect(replayed.reasoning_opaque).toBe(opaque);
		expect(replayed.reasoning_text).toBe("Thinking about echo.");
		expect(replayed.reasoning_details).toBeUndefined();
		expect(replayed.tool_calls).toHaveLength(1);
	});
});
