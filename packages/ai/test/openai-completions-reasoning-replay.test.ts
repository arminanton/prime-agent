import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	convertMessages,
	streamOpenAICompletions,
	streamSimpleOpenAICompletions,
} from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
	nonStreaming: false,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function buildModel(): Model<"openai-completions"> {
	return {
		id: "repro-model",
		name: "Repro Model",
		api: "openai-completions",
		provider: "repro-provider",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildContext(content: AssistantMessage["content"]): Context {
	return {
		messages: [
			{ role: "user", content: "hello", timestamp: 1 },
			{
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "repro-provider",
				model: "repro-model",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 2,
			} satisfies AssistantMessage,
			{ role: "user", content: "continue", timestamp: 3 },
		],
	};
}

describe("openai-completions reasoning replay", () => {
	it("replays thinking into the field recorded by thinkingSignature", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "step by step", thinkingSignature: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.content).toBe("answer");
		expect(assistant.reasoning).toBe("step by step");
	});

	it("keeps unsigned thinking as text when the provider doesn't use a reasoning field", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "answer" },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBeUndefined();
		expect(assistant.content).toBe("unsigned reasoning\n\nanswer");
	});

	it("uses reasoning_content for unsigned thinking only when the provider requires it", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "unsigned reasoning" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBe("unsigned reasoning");
		expect(assistant.content).toBe("answer");
	});

	it("writes reasoning_content (not the signature field) when the provider requires it", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "step by step", thinkingSignature: "reasoning" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content).toBe("step by step");
	});

	it("sanitizes unpaired surrogates in replayed reasoning", () => {
		const reasoningCompat = { ...compat, requiresReasoningContentOnAssistantMessages: true };
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "before\ud800after" },
				{ type: "text", text: "answer" },
			]),
			reasoningCompat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning_content as string).not.toContain("\ud800");
	});

	it.each([
		{
			name: "thinking plus text",
			content: [
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "text", text: "visible answer" },
			] as AssistantMessage["content"],
			expected: [
				{ type: "text", text: "internal reasoning" },
				{ type: "text", text: "visible answer" },
			],
		},
		{
			name: "thinking only",
			content: [{ type: "thinking", thinking: "internal reasoning" }] as AssistantMessage["content"],
			expected: [{ type: "text", text: "internal reasoning" }],
		},
	])(
		"serializes $name as assistant text parts when the provider requires thinking-as-text",
		({ content, expected }) => {
			const messages = convertMessages(buildModel(), buildContext(content), {
				...compat,
				requiresThinkingAsText: true,
			});

			expect(messages[1]).toEqual({ role: "assistant", content: expected });
		},
	);

	it("replays signed thinking alongside a tool call", () => {
		const messages = convertMessages(
			buildModel(),
			buildContext([
				{ type: "thinking", thinking: "deciding to call a tool", thinkingSignature: "reasoning" },
				{ type: "toolCall", id: "call-1", name: "search", arguments: { q: "x" } },
			]),
			compat,
		);

		const assistant = messages[1] as unknown as Record<string, unknown>;
		expect(assistant.reasoning).toBe("deciding to call a tool");
		expect(Array.isArray(assistant.tool_calls)).toBe(true);
	});
});

const copilotGemini: Model<"openai-completions"> = {
	...buildModel(),
	id: "gemini-3.8-flash",
	provider: "github-copilot",
	baseUrl: "https://copilot.invalid",
	maxTokens: 200_000,
	contextWindow: 1_048_576,
	thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", max: null },
	compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
};
const copilotContext: Context = {
	messages: [{ role: "user", content: "Echo x", timestamp: 1 }],
	tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ value: Type.String() }) }],
};
function completionResponse(
	message: Record<string, unknown>,
	finishReason = "stop",
	streaming = false,
	alternatives = false,
): Response {
	const delta = { ...message };
	if (Array.isArray(message.tool_calls)) {
		delta.tool_calls = message.tool_calls.map((call, index) => ({ index, ...(call as Record<string, unknown>) }));
	}
	const choice = (value: Record<string, unknown>, index = 0) => ({
		index,
		finish_reason: index === 0 ? finishReason : "stop",
		...(streaming ? { delta: value } : { message: { role: "assistant", ...value } }),
	});
	const choices = [choice(streaming ? delta : message)];
	if (alternatives) choices.push(choice({ content: "discarded alternative" }, 1));
	const body = {
		id: "completion-1",
		object: streaming ? "chat.completion.chunk" : "chat.completion",
		created: 1,
		model: copilotGemini.id,
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		choices,
	};
	return streaming
		? new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			})
		: Response.json(body);
}

describe("Copilot completions wire contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each([undefined, false])(
		"replays complete Gemini thinking and only the first choice (nonStreaming=%s)",
		async (nonStreaming) => {
			vi.stubEnv("GITHUB_COPILOT_INTEGRATION_ID", "");
			const model = { ...copilotGemini, compat: { ...copilotGemini.compat, nonStreaming } };
			const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
			let hookPayload: Record<string, unknown> = {};
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				requests.push({
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
					headers: new Headers(init?.headers),
				});
				return requests.length === 1
					? completionResponse(
							{
								content: null,
								reasoning_text: "Full trailing reasoning.",
								reasoning_opaque: "OPAQUE",
								tool_calls: [
									{ id: "call_1", type: "function", function: { name: "echo", arguments: '{"value":"x"}' } },
								],
							},
							"tool_calls",
							nonStreaming === false,
							true,
						)
					: completionResponse({ content: "done" }, "stop", nonStreaming === false);
			});
			const options = {
				apiKey: "test-key",
				sessionId: `copilot-gemini-${nonStreaming}`,
				cacheRetention: "long" as const,
				headers: { "User-Agent": "stale", "Editor-Plugin-Version": "stale" },
				onPayload: (value: unknown) => {
					hookPayload = structuredClone(value) as Record<string, unknown>;
				},
			};
			const stream = streamSimpleOpenAICompletions(model, copilotContext, options);
			const events: string[] = [];
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(result).toMatchObject({
				stopReason: "toolUse",
				responseId: "completion-1",
				usage: { input: 10, output: 5, totalTokens: 15 },
			});
			expect(result.content).toMatchObject([
				{ type: "thinking", thinking: "Full trailing reasoning." },
				{ type: "toolCall", id: "call_1", name: "echo", arguments: { value: "x" } },
			]);
			expect(events).toEqual(expect.arrayContaining(["thinking_delta", "toolcall_end"]));
			expect(events.filter((type) => type === "done" || type === "error")).toEqual(["done"]);
			expect(hookPayload.stream).toBe(nonStreaming === false);
			expect(hookPayload.stream_options).toEqual(nonStreaming === false ? { include_usage: true } : undefined);
			const { body, headers } = requests[0];
			expect(body).toMatchObject({
				stream: nonStreaming === false,
				reasoning_effort: "high",
				temperature: 1,
				tool_choice: "validated",
				snippy: { enabled: false },
			});
			expect(body.stream_options).toEqual(nonStreaming === false ? { include_usage: true } : undefined);
			for (const field of [
				"reasoning",
				"max_tokens",
				"max_completion_tokens",
				"prompt_cache_key",
				"prompt_cache_retention",
				"store",
			])
				expect(body[field]).toBeUndefined();
			expect(headers.get("user-agent")).toMatch(/^copilot\/1\.0\.84-5 .* client\/github\/cli$/);
			expect(headers.get("copilot-integration-id")).toBe("copilot-developer-cli");
			expect(headers.get("openai-intent")).toBe("conversation-agent");
			expect(headers.get("x-stainless-helper-method")).toBe(nonStreaming === false ? "stream" : null);
			for (const name of ["editor-plugin-version", "x-stainless-lang", "x-stainless-runtime-version"])
				expect(headers.get(name)).toBeNull();
			const final = await streamSimpleOpenAICompletions(
				model,
				{
					...copilotContext,
					messages: [
						...copilotContext.messages,
						result,
						{
							role: "toolResult",
							toolCallId: "call_1",
							toolName: "echo",
							content: [{ type: "text", text: "x" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				options,
			).result();
			expect(final.stopReason).toBe("stop");
			expect(final.content).toEqual([{ type: "text", text: "done" }]);
			expect(requests).toHaveLength(2);
			const replay = (requests[1].body.messages as Record<string, unknown>[]).find(
				(message) => message.role === "assistant",
			);
			expect(replay).toMatchObject({
				reasoning_text: "Full trailing reasoning.",
				reasoning_opaque: "OPAQUE",
				tool_calls: [{ id: "call_1", function: { name: "echo", arguments: '{"value":"x"}' } }],
			});
			expect(replay).not.toHaveProperty("reasoning_details");
		},
	);

	it.each(["length", "content_filter", "network_error", "unexpected_finish", "http400"])(
		"preserves JSON completion terminal state: %s",
		async (finish) => {
			vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
				finish === "http400"
					? Response.json({ error: { message: "http400" } }, { status: 400 })
					: completionResponse({ content: "partial" }, finish),
			);
			const stream = streamOpenAICompletions(copilotGemini, copilotContext, { apiKey: "test-key" });
			const terminals: string[] = [];
			for await (const event of stream)
				if (event.type === "done" || event.type === "error") terminals.push(event.type);
			const result = await stream.result();
			expect(result.stopReason).toBe(finish === "length" ? "length" : "error");
			expect(terminals).toEqual([finish === "length" ? "done" : "error"]);
			expect(result.errorMessage).toEqual(finish === "length" ? undefined : expect.stringContaining(finish));
			expect(result.content).toEqual(finish === "http400" ? [] : [{ type: "text", text: "partial" }]);
		},
	);

	it("aborts a pending Gemini JSON request at the fetch boundary", async () => {
		let notify!: () => void;
		const started = new Promise<void>((resolve) => {
			notify = resolve;
		});
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
						once: true,
					});
					notify();
				}),
		);
		const controller = new AbortController();
		try {
			const stream = streamOpenAICompletions(copilotGemini, copilotContext, {
				apiKey: "test-key",
				signal: controller.signal,
			});
			await started;
			expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
			controller.abort();
			const terminals: string[] = [];
			for await (const event of stream)
				if (event.type === "done" || event.type === "error") terminals.push(event.type);
			expect((await stream.result()).stopReason).toBe("aborted");
			expect(terminals).toEqual(["error"]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			controller.abort();
		}
	});
});
