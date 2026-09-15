import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import type { Context } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
	createParams: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: (params: Record<string, unknown>) => {
				mockState.createParams = params;
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("Copilot Claude via Anthropic Messages", () => {
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	it("uses Bearer auth, Copilot headers, and valid Anthropic Messages payload", async () => {
		const model = getModel("github-copilot", "claude-sonnet-4.6");
		expect(model.api).toBe("anthropic-messages");

		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(model, context, { apiKey: "tid_copilot_session_test_token" });
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const opts = mockState.constructorOpts!;
		expect(opts).toBeDefined();

		expect(opts.apiKey).toBeNull();
		expect(opts.authToken).toBe("tid_copilot_session_test_token");
		const headers = opts.defaultHeaders as Record<string, string>;

		// Identity matches the official @github/copilot CLI 1.0.84-5.
		expect(headers["User-Agent"]).toMatch(/^copilot\/1\.0\.84-5 .* client\/github\/cli$/);
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
		expect(headers["Editor-Version"]).toBe("copilot/1.0.84-5");
		expect(headers["Editor-Plugin-Version"]).toBeUndefined();
		expect(headers["X-GitHub-Api-Version"]).toBe("2026-08-01");

		// Anthropic uses the common attribution headers but not Openai-Intent.
		expect(headers["X-Initiator"]).toBe("user");
		expect(headers["Openai-Intent"]).toBeUndefined();
		expect(headers["X-Interaction-Type"]).toBe("conversation-user");
		expect(headers["Copilot-Harness-Id"]).toBe("copilot-sdk");

		// Per-install / per-conversation / per-call ids the CLI carries.
		expect(headers["X-Client-Machine-Id"]).toBeTruthy();
		expect(headers["X-Client-Session-Id"]).toBeTruthy();
		expect(headers["X-Interaction-Id"]).toBeTruthy();

		const beta = headers["anthropic-beta"] ?? "";
		expect(beta).not.toContain("fine-grained-tool-streaming");

		const params = mockState.createParams!;
		expect(params.model).toBe("claude-sonnet-4.6");
		expect(params.stream).toBe(true);
		expect(params.max_tokens).toBeGreaterThan(0);
		expect(Array.isArray(params.messages)).toBe(true);
	});

	it("sends no anthropic-beta or browser-access header and nulls SDK fingerprints on Copilot", async () => {
		// The official CLI carries no anthropic-beta on ordinary Copilot requests (CAPI
		// ignores or denylists them), uses accept */* on /v1/messages, and sends only
		// X-Stainless-Helper-Method from the SDK fingerprint set.
		const model = getModel("github-copilot", "claude-haiku-4.5");
		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(model, context, {
			apiKey: "tid_copilot_session_test_token",
			interleavedThinking: true,
		});
		for await (const event of s) {
			if (event.type === "error") break;
		}

		const headers = mockState.constructorOpts!.defaultHeaders as Record<string, string | null>;
		expect(headers["anthropic-beta"]).toBeUndefined();
		expect(headers["anthropic-dangerous-direct-browser-access"]).toBeUndefined();
		expect(headers.accept).toBe("*/*");
		expect(headers["X-Stainless-Lang"]).toBeNull();
		expect(headers["X-Stainless-Runtime-Version"]).toBeNull();
		expect(headers["X-Stainless-Helper-Method"]).toBe("stream");
	});
});
