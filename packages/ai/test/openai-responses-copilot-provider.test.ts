import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";

type CapturedHeaders = Headers | string[][] | Record<string, string | readonly string[]> | undefined;

function getHeader(headers: CapturedHeaders, name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	const lowerName = name.toLowerCase();
	if (Array.isArray(headers)) {
		return headers.find(([key]) => key?.toLowerCase() === lowerName)?.[1] ?? null;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return typeof value === "string" ? value : value.join(", ");
	}
	return null;
}

const proxyModel = (compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> => ({
	...getModel("openai", "gpt-5.4"),
	provider: "opencode",
	baseUrl: "https://proxy.example.com/v1",
	...(compat ? { compat } : {}),
});

/** Drives one request against a stubbed SSE endpoint and returns the payload plus request headers. */
async function captureRequest(
	model: Model<"openai-responses">,
	options: Parameters<typeof streamOpenAIResponses>[2] = {},
): Promise<{ payload: unknown; sessionId: string | null; clientRequestId: string | null }> {
	const captured = {
		payload: undefined as unknown,
		sessionId: null as string | null,
		clientRequestId: null as string | null,
	};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		captured.sessionId = getHeader(init?.headers, "session_id");
		captured.clientRequestId = getHeader(init?.headers, "x-client-request-id");
		return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
	});

	const stream = streamOpenAIResponses(
		model,
		{ systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{
			apiKey: "test-key",
			...options,
			onPayload: (payload) => {
				captured.payload = payload;
			},
		},
	);
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

// "none" = the model accepts an explicit off switch; "absent" = the field must not be serialized.
const REASONING_DEFAULTS: Array<{
	provider: "openai" | "github-copilot";
	modelId: string;
	effort: "none" | "absent";
	model: () => Model<"openai-responses">;
}> = [
	{
		provider: "github-copilot",
		modelId: "gpt-5-mini",
		effort: "absent",
		model: () => getModel("github-copilot", "gpt-5-mini"),
	},
	...(["gpt-5.1", "gpt-5.2", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5"] as const).map(
		(modelId) => ({
			provider: "openai" as const,
			modelId,
			effort: "none" as const,
			model: () => getModel("openai", modelId),
		}),
	),
	...(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro", "gpt-5.2-pro", "gpt-5.4-pro", "gpt-5.5-pro"] as const).map(
		(modelId) => ({
			provider: "openai" as const,
			modelId,
			effort: "absent" as const,
			model: () => getModel("openai", modelId),
		}),
	),
];

describe("openai-responses provider defaults", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(REASONING_DEFAULTS)(
		"serializes $effort reasoning effort for $provider $modelId when no reasoning is requested",
		async ({ effort, model }) => {
			const { payload } = await captureRequest(model());

			if (effort === "none") {
				expect(payload).toMatchObject({ reasoning: { effort: "none" } });
			} else {
				expect(payload).not.toMatchObject({ reasoning: expect.anything() });
			}
		},
	);

	it.each([
		{
			name: "official OpenAI Responses requests with a sessionId",
			model: () => getModel("openai", "gpt-5.4"),
			options: { sessionId: "session-123" },
			expected: { sessionId: "session-123", clientRequestId: "session-123" },
		},
		{
			name: "proxy Responses requests with a sessionId",
			model: () => proxyModel(),
			options: { sessionId: "session-123" },
			expected: { sessionId: "session-123", clientRequestId: "session-123" },
		},
		{
			name: "a model that opts out of the session_id header",
			model: () => proxyModel({ sendSessionIdHeader: false }),
			options: { sessionId: "session-123" },
			expected: { sessionId: null, clientRequestId: "session-123" },
		},
		{
			name: "explicit header overrides",
			model: () => getModel("openai", "gpt-5.4"),
			options: {
				sessionId: "session-123",
				headers: { session_id: "override-session", "x-client-request-id": "override-request" },
			},
			expected: { sessionId: "override-session", clientRequestId: "override-request" },
		},
		{
			name: "cacheRetention none",
			model: () => getModel("openai", "gpt-5.4"),
			options: { cacheRetention: "none" as const, sessionId: "session-123" },
			expected: { sessionId: null, clientRequestId: null },
		},
	])("sends cache-affinity headers for $name", async ({ model, options, expected }) => {
		const { sessionId, clientRequestId } = await captureRequest(model(), options);

		expect({ sessionId, clientRequestId }).toEqual(expected);
	});

	it.each([
		["github-copilot" as const, "auto" as const, false],
		["github-copilot" as const, "default" as const, false],
		["openai" as const, "default" as const, true],
	])("scopes service_tier serialization to the provider (%s, %s)", async (provider, serviceTier, expected) => {
		const model = { ...getModel("openai", "gpt-5.4"), provider };
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
});

const copilotResponseModel: Model<"openai-responses"> = {
	...getModel("openai", "gpt-5.4"),
	provider: "github-copilot",
	baseUrl: "https://copilot.invalid",
	compat: { supportsLongCacheRetention: true, sendSessionIdHeader: true },
};
const responseContext: Context = {
	messages: [{ role: "user", content: "Echo x", timestamp: 1 }],
	tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ value: Type.String() }) }],
};
function recordResponseRequests(rejection?: { message: string; status: number; repeat?: boolean }) {
	const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		requests.push({
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			headers: new Headers(init?.headers),
		});
		return rejection && (requests.length === 1 || rejection.repeat)
			? Response.json({ error: { message: rejection.message } }, { status: rejection.status })
			: new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: {
							status: "completed",
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
	});
	return requests;
}

describe("Copilot Responses wire contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("uses the CLI identity and omits sampling and cache hints even with long retention enabled", async () => {
		vi.stubEnv("GITHUB_COPILOT_INTEGRATION_ID", "");
		const requests = recordResponseRequests();
		const result = await streamOpenAIResponses(copilotResponseModel, responseContext, {
			apiKey: "test-key",
			sessionId: "copilot-responses",
			cacheRetention: "long",
			temperature: 0.2,
			reasoningEffort: "high",
			serviceTier: "default",
			headers: { "User-Agent": "stale", "Editor-Version": "stale", "Editor-Plugin-Version": "stale" },
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		const { body, headers } = requests[0];
		expect(body).toMatchObject({
			stream: true,
			store: false,
			reasoning: { effort: "high", summary: "auto" },
			include: ["reasoning.encrypted_content"],
			parallel_tool_calls: true,
		});
		for (const field of ["temperature", "prompt_cache_key", "prompt_cache_retention", "service_tier", "long_context"])
			expect(body[field]).toBeUndefined();
		expect(headers.get("authorization")).toBe("Bearer test-key");
		expect(headers.get("user-agent")).toMatch(/^copilot\/1\.0\.84-5 .* client\/github\/cli$/);
		expect(headers.get("copilot-integration-id")).toBe("copilot-developer-cli");
		expect(headers.get("x-client-session-id")).toBe("copilot-responses");
		expect(headers.get("openai-intent")).toBe("conversation-agent");
		for (const name of [
			"editor-plugin-version",
			"x-stainless-lang",
			"x-stainless-runtime-version",
			"session_id",
			"x-client-request-id",
		])
			expect(headers.get(name)).toBeNull();
	});

	it.each([
		["github-copilot", undefined, undefined],
		["github-copilot", 2048, 2048],
		["openai", undefined, 32_000],
		["openai", 2048, 2048],
	] as const)("scopes simple output defaults to %s (override=%s)", async (provider, maxTokens, expected) => {
		const requests = recordResponseRequests();
		const result = await streamSimpleOpenAIResponses({ ...copilotResponseModel, provider }, responseContext, {
			apiKey: "test-key",
			maxTokens,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].body.max_output_tokens).toBe(expected);
	});

	it.each(["off", undefined] as const)("honors explicit Copilot reasoning selection: %s", async (reasoning) => {
		const requests = recordResponseRequests();
		const model = getModel("github-copilot", "gpt-5.4");
		const result = await streamSimpleOpenAIResponses(model, responseContext, {
			apiKey: "test-key",
			reasoning,
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0].body.reasoning).toEqual(reasoning === "off" ? { effort: "none" } : undefined);
		expect(requests[0].body.include).toBeUndefined();
	});

	const sampling = "Unsupported parameter: 'temperature' is not supported with this model.";
	const effortError = 'reasoning_effort "max" is not supported by model gpt-5.4; supported values: [low medium high]';
	it.each([
		["sampling", 400, "github-copilot", sampling, false, 2, "stop", undefined, "max"],
		["effort", 400, "github-copilot", effortError, false, 2, "stop", 0.5, "high"],
		["second rejection", 400, "github-copilot", sampling, true, 2, "error", undefined, "max"],
		["tools", 400, "github-copilot", "Unsupported parameter: 'tools'", false, 1, "error", 0.5, "max"],
		["input", 400, "github-copilot", "Unsupported parameter: 'input'", false, 1, "error", 0.5, "max"],
		["unknown error", 400, "github-copilot", "Bad request", false, 1, "error", 0.5, "max"],
		["non-400", 422, "github-copilot", sampling, false, 1, "error", 0.5, "max"],
		["other provider", 400, "openai", sampling, false, 1, "error", 0.5, "max"],
	] as const)(
		"adjusts only a fixable Copilot 400 once: %s",
		async (_name, status, provider, message, repeat, attempts, stopReason, temperature, effort) => {
			const requests = recordResponseRequests({ status, message, repeat });
			const result = await streamOpenAIResponses({ ...copilotResponseModel, provider }, responseContext, {
				apiKey: "test-key",
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					temperature: 0.5,
					reasoning: { effort: "max", summary: "auto" },
				}),
			}).result();
			expect(requests).toHaveLength(attempts);
			expect(result.stopReason).toBe(stopReason);
			expect(result.errorMessage).toEqual(stopReason === "error" ? expect.stringContaining(message) : undefined);
			const last = requests[requests.length - 1].body;
			expect(last.temperature).toBe(temperature);
			expect(last.reasoning).toEqual({ effort, summary: "auto" });
			expect(last.input).toEqual(requests[0].body.input);
			expect(last.tools).toEqual(requests[0].body.tools);
		},
	);
});
