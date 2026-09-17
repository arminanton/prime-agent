import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { type AnthropicOptions, streamAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, SimpleStreamOptions, Tool, UserMessage } from "../src/types.js";
import { isContextOverflow } from "../src/utils/overflow.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic thinking disable payload", () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.7 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("clamps xhigh reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { reasoning: "xhigh" });

		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Sonnet 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-6"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("omits the thinking param for Claude Fable 5 when reasoning is off (explicit disabled is a 400)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("drops temperature for Claude Fable 5 (sampling params are rejected)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { temperature: 0.5 });

		expect(payload.temperature).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("uses adaptive thinking with effort=xhigh for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max reasoning to effort=max for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});
});

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

async function captureAnthropicRequest(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		capturedRequest = {
			headers: request.headers,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
		};
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		const s = streamAnthropic({ ...model, baseUrl: `http://127.0.0.1:${port}` }, context, options);
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	if (!capturedRequest) throw new Error("Anthropic request was not captured");
	return capturedRequest;
}

function toolsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return (body.tools ?? []) as Array<Record<string, unknown>>;
}

function tool(name: string): Tool {
	return { name, description: `Tool ${name}`, parameters: Type.Object({ value: Type.String() }) };
}

const toolContext: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: 1 }],
	tools: [tool("lookup")],
};

describe("Anthropic request wire contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
	const testModel: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-opus-4-7"),
		provider: "test-anthropic",
	};

	it.each([
		{
			name: "sends per-tool eager_input_streaming by default",
			compat: undefined,
			context: toolContext,
			eager: true,
			beta: undefined,
		},
		{
			name: "uses the legacy fine-grained beta when eager tool input streaming is disabled",
			compat: { supportsEagerToolInputStreaming: false },
			context: toolContext,
			eager: undefined,
			beta: "fine-grained-tool-streaming-2025-05-14",
		},
		{
			name: "omits the legacy fine-grained beta when there are no tools",
			compat: { supportsEagerToolInputStreaming: false },
			context: { messages: toolContext.messages } as Context,
			eager: undefined,
			beta: undefined,
		},
	])("$name", async ({ compat, context, eager, beta }) => {
		const request = await captureAnthropicRequest({ ...testModel, compat }, context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});

		expect(toolsOf(request.body)[0]?.eager_input_streaming).toBe(eager);
		expect(request.headers["anthropic-beta"]).toBe(beta);
	});

	it("renames user tools to their Claude Code casing only for OAuth tokens", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
			tools: [tool("todowrite"), tool("find"), tool("my_custom_tool")],
		};

		const oauth = await captureAnthropicRequest(getModel("anthropic", "claude-sonnet-4-6"), context, {
			apiKey: "sk-ant-oat-fake-token",
			cacheRetention: "none",
		});
		expect(toolsOf(oauth.body).map((entry) => entry.name)).toEqual(["TodoWrite", "find", "my_custom_tool"]);

		const apiKey = await captureAnthropicRequest(getModel("anthropic", "claude-sonnet-4-6"), context, {
			apiKey: "sk-ant-api-fake-token",
			cacheRetention: "none",
		});
		expect(toolsOf(apiKey.body).map((entry) => entry.name)).toEqual(["todowrite", "find", "my_custom_tool"]);
	});

	it("sends Copilot bearer auth, CLI identity, and a valid Anthropic Messages payload", async () => {
		vi.stubEnv("GITHUB_COPILOT_INTEGRATION_ID", "");
		const model = getModel("github-copilot", "claude-fable-5.1");
		expect(model.api).toBe("anthropic-messages");
		const request = await captureAnthropicRequest(
			model as Model<"anthropic-messages">,
			{ systemPrompt: "You are a helpful assistant.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{
				apiKey: "tid_copilot_session_test_token",
				headers: { "User-Agent": "stale", "Editor-Plugin-Version": "stale", "Openai-Intent": "conversation-edits" },
			},
		);
		expect(request.headers.authorization).toBe("Bearer tid_copilot_session_test_token");
		expect(request.headers["x-api-key"]).toBeUndefined();
		expect(request.headers["user-agent"]).toMatch(/^copilot\/1\.0\.84-5 .* client\/github\/cli$/);
		expect(request.headers["copilot-integration-id"]).toBe("copilot-developer-cli");
		expect(request.headers["x-initiator"]).toBe("user");
		expect(request.headers["openai-intent"]).toBeUndefined();
		expect(request.headers["editor-plugin-version"]).toBeUndefined();
		expect(request.body).toMatchObject({
			model: "claude-fable-5.1",
			stream: true,
			max_tokens: 128_000,
			temperature: 1,
		});
		expect(Array.isArray(request.body.messages)).toBe(true);
	});

	it("allows browser clients without Copilot beta or browser-access headers", async () => {
		vi.stubGlobal("window", { document: {} });
		vi.stubGlobal("navigator", { userAgent: "test-browser" });
		const request = await captureAnthropicRequest(
			getModel("github-copilot", "claude-haiku-4.5") as Model<"anthropic-messages">,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ apiKey: "tid_copilot_session_test_token", interleavedThinking: true },
		);
		for (const name of [
			"anthropic-beta",
			"anthropic-dangerous-direct-browser-access",
			"x-stainless-lang",
			"x-stainless-runtime-version",
		]) {
			expect(request.headers[name]).toBeUndefined();
		}
		expect(request.headers.accept).toBe("*/*");
		expect(request.headers["x-stainless-helper-method"]).toBe("stream");
	});

	it.each([false, true])("keeps the 128K Copilot output cap on large contexts (image=%s)", async (image) => {
		const content: UserMessage["content"] = [{ type: "text", text: "word ".repeat(780_000) }];
		if (image) {
			const data = readFileSync(new URL("./data/red-circle.png", import.meta.url)).toString("base64");
			content.push({ type: "image", mimeType: "image/png", data });
		}
		const context: Context = { messages: [{ role: "user", timestamp: 1, content }] };
		const request = await captureAnthropicRequest(
			getModel("github-copilot", "claude-fable-5.1") as Model<"anthropic-messages">,
			context,
			{ apiKey: "test-key" },
		);
		expect(request.body.max_tokens).toBe(128_000);
		expect(request.headers["copilot-vision-request"]).toBe(image ? "true" : undefined);
	});

	const capError = "max_tokens: 64000 > 8192, which is the maximum allowed number of output tokens";
	const combinedError = "input length and `max_tokens` exceed context limit: 190000 + 64000 > 200000";
	const completed =
		'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n';
	it.each([
		["reported cap", capError, 8192, 8192],
		["combined context", combinedError, 5904, 64_000],
	] as const)(
		"reduces output and manual thinking once for a Copilot %s rejection",
		async (_name, message, reduced, nextCap) => {
			const model: Model<"anthropic-messages"> = {
				...getModel("github-copilot", "claude-haiku-4.5"),
				baseUrl: `https://copilot.invalid/${crypto.randomUUID()}`,
			};
			const requests: Record<string, unknown>[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return requests.length === 1
					? Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 })
					: new Response(completed, { headers: { "content-type": "text/event-stream" } });
			});
			const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };
			const result = await streamSimpleAnthropic(model, context, { apiKey: "test-key", reasoning: "max" }).result();
			expect(result.stopReason).toBe("stop");
			expect(requests.map((body) => body.max_tokens)).toEqual([64_000, reduced]);
			expect(requests[0].thinking).toMatchObject({ type: "enabled", budget_tokens: 32_000 });
			expect(requests[1].thinking).toMatchObject({ type: "enabled", budget_tokens: reduced - 1 });
			await streamSimpleAnthropic(model, context, { apiKey: "test-key", reasoning: "off" }).result();
			expect(requests).toHaveLength(3);
			expect(requests[2].max_tokens).toBe(nextCap);
		},
	);

	it.each([
		["repeated cap", 400, capError, 2, false],
		["non-400 cap", 422, capError, 1, false],
		["prompt overflow", 400, "prompt is too long: 1000001 tokens > 1000000 maximum", 1, true],
		[
			"exhausted combined context",
			400,
			"input length and `max_tokens` exceed context limit: 201000 + 64000 > 200000",
			1,
			true,
		],
	] as const)("surfaces %s without unbounded adjustment", async (_name, status, message, attempts, overflow) => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () =>
				Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status }),
			);
		const model: Model<"anthropic-messages"> = {
			...getModel("github-copilot", "claude-haiku-4.5"),
			baseUrl: `https://copilot.invalid/${crypto.randomUUID()}`,
		};
		const result = await streamAnthropic(model, toolContext, { apiKey: "test-key" }).result();
		expect(fetchMock).toHaveBeenCalledTimes(attempts);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(message);
		expect(isContextOverflow(result)).toBe(overflow);
	});
});
