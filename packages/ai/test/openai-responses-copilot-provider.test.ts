import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Model } from "../src/types.js";

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

async function captureOpenAIResponseHeaders(
	options: Parameters<typeof streamOpenAIResponses>[2],
	model: Model<"openai-responses"> = getModel("openai", "gpt-5.4"),
): Promise<{ sessionId: string | null; clientRequestId: string | null }> {
	const captured = { sessionId: null as string | null, clientRequestId: null as string | null };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});

	const stream = streamOpenAIResponses(
		model,
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key", ...options },
	);

	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}

	return captured;
}

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("omits reasoning when no reasoning is requested", async () => {
		const model = getModel("github-copilot", "gpt-5-mini");
		let capturedPayload: unknown;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload).not.toMatchObject({
			reasoning: expect.anything(),
		});
		expect(capturedPayload).not.toHaveProperty("parallel_tool_calls");
	});

	it("matches the official Copilot Responses reasoning and parallel-tool defaults", async () => {
		const model = getModel("github-copilot", "gpt-5.5");
		let capturedPayload: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [
					{
						name: "echo",
						description: "Echo text",
						parameters: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			},
			{
				apiKey: "test-key",
				reasoningEffort: "medium",
				onPayload: (payload) => {
					capturedPayload = payload as Record<string, unknown>;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toMatchObject({
			reasoning: { effort: "medium", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			parallel_tool_calls: true,
		});
		expect(capturedPayload).not.toHaveProperty("long_context");
	});

	it("never sends service_tier for Copilot (the provider rejects it with 400)", async () => {
		const model = getModel("github-copilot", "gpt-5.5");
		let capturedPayload: Record<string, unknown> | undefined;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				// Even when the session hands us a tier, Copilot must not receive it.
				serviceTier: "default",
				onPayload: (payload) => {
					capturedPayload = payload as Record<string, unknown>;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toBeDefined();
		expect(capturedPayload).not.toHaveProperty("service_tier");
	});

	it("never sends temperature to a Copilot reasoning model on /responses", async () => {
		const model = getModel("github-copilot", "gpt-6-astra");
		let capturedPayload: Record<string, unknown> | undefined;
		let capturedHeaders: CapturedHeaders;

		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			capturedHeaders = init?.headers as CapturedHeaders;
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{
				apiKey: "test-key",
				temperature: 0.2,
				reasoningEffort: "high",
				onPayload: (payload) => {
					capturedPayload = payload as Record<string, unknown>;
				},
			},
		);

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(capturedPayload).toBeDefined();
		expect(capturedPayload).not.toHaveProperty("temperature");
		expect(capturedPayload).toMatchObject({ reasoning: { effort: "high" } });
		// SDK fingerprint headers are nulled; only the helper marker remains.
		expect(getHeader(capturedHeaders, "X-Stainless-Lang")).toBeNull();
		expect(getHeader(capturedHeaders, "X-Stainless-Helper-Method")).toBe("stream");
	});

	it.each(["gpt-5.1", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"] as const)(
		"sends none reasoning effort for OpenAI %s when no reasoning is requested",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).toMatchObject({
				reasoning: { effort: "none" },
			});
		},
	);

	it.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const)(
		"omits reasoning effort for OpenAI %s when off is unsupported",
		async (modelId) => {
			const model = getModel("openai", modelId);
			let capturedPayload: unknown;

			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);

			const stream = streamOpenAIResponses(
				model,
				{
					systemPrompt: "sys",
					messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				},
				{
					apiKey: "test-key",
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}

			expect(capturedPayload).not.toMatchObject({
				reasoning: expect.anything(),
			});
		},
	);

	it("sets cache-affinity headers for official OpenAI Responses requests with a sessionId", async () => {
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("sets cache-affinity headers for proxy OpenAI Responses requests with a sessionId", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured).toEqual({ sessionId: "session-123", clientRequestId: "session-123" });
	});

	it("can omit the session_id header while preserving other cache-affinity headers", async () => {
		const proxyModel: Model<"openai-responses"> = {
			...getModel("openai", "gpt-5.4"),
			provider: "opencode",
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionIdHeader: false },
		};
		const captured = await captureOpenAIResponseHeaders({ sessionId: "session-123" }, proxyModel);

		expect(captured).toEqual({ sessionId: null, clientRequestId: "session-123" });
	});

	it("lets explicit headers override the default OpenAI cache-affinity headers", async () => {
		const captured = await captureOpenAIResponseHeaders({
			sessionId: "session-123",
			headers: {
				session_id: "override-session",
				"x-client-request-id": "override-request",
			},
		});

		expect(captured).toEqual({ sessionId: "override-session", clientRequestId: "override-request" });
	});

	it("omits OpenAI cache-affinity headers when cacheRetention is none", async () => {
		const captured = await captureOpenAIResponseHeaders({ cacheRetention: "none", sessionId: "session-123" });

		expect(captured).toEqual({ sessionId: null, clientRequestId: null });
	});

	it.each([
		["github-copilot" as const, "auto" as const, false],
		["github-copilot" as const, "default" as const, false],
		["openai" as const, "default" as const, true],
	])("scopes service_tier serialization to the provider (%s, %s)", async (provider, serviceTier, expected) => {
		const base = getModel("openai", "gpt-5.4");
		const model = { ...base, provider };
		const sse = `data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		})}\n\n`;
		let wireBody: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
			wireBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const result = await streamOpenAIResponses(
			model,
			{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key", serviceTier },
		).result();

		expect(result.stopReason).toBe("stop");
		// Copilot rejects the FIELD for every value; elsewhere absence means "auto"
		// (the project tier), so an explicit "default" must stay on the wire.
		expect(wireBody && "service_tier" in wireBody).toBe(expected);
		if (expected) {
			expect((wireBody as Record<string, unknown>).service_tier).toBe(serviceTier);
		}
	});

	it.each([
		["gpt-5.4", "priority", 2],
		["gpt-5.5", "priority", 2.5],
		["gpt-5.5", "flex", 0.5],
	] as const)("applies %s %s service-tier cost multiplier", async (modelId, serviceTier, multiplier) => {
		const model = getModel("openai", modelId);
		const sse = `${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					service_tier: serviceTier,
					usage: {
						input_tokens: 1000000,
						output_tokens: 1000000,
						total_tokens: 2000000,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
		].join("\n\n")}\n\n`;

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(sse, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const stream = streamOpenAIResponses(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", serviceTier },
		);

		const result = await stream.result();

		expect(result.usage.cost.input).toBe(model.cost.input * multiplier);
		expect(result.usage.cost.output).toBe(model.cost.output * multiplier);
		expect(result.usage.cost.total).toBe((model.cost.input + model.cost.output) * multiplier);
	});
});
