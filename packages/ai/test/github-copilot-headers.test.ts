import { afterEach, describe, expect, it } from "vitest";
import {
	buildCopilotCatalogHeaders,
	buildCopilotDynamicHeaders,
	copilotCliVersion,
	copilotControlPlaneUserAgent,
	copilotIntegrationId,
	copilotUserAgent,
	inferCopilotInitiator,
	resetCopilotTurnIds,
	sanitizeCopilotModelHeaders,
} from "../src/providers/github-copilot-headers.js";
import type { Message } from "../src/types.js";

const userTurn: Message[] = [{ role: "user", content: "hi", timestamp: Date.now() }];
const agentTurn: Message[] = [
	{ role: "user", content: "hi", timestamp: Date.now() },
	{
		role: "assistant",
		content: [{ type: "text", text: "working" }],
		api: "openai-completions",
		provider: "github-copilot",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	},
];

describe("copilot dynamic headers", () => {
	afterEach(() => {
		delete process.env.COPILOT_CLI_VERSION;
		delete process.env.GITHUB_COPILOT_INTEGRATION_ID;
	});

	it("presents the captured Copilot CLI 1.0.84-5 identity", () => {
		const headers = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
		expect(headers["User-Agent"]).toMatch(
			new RegExp(`^copilot/1\\.0\\.84-5 \\(${process.platform} v24\\.20\\.0\\) term/.+ client/github/cli$`),
		);
		expect(headers["Editor-Version"]).toBe("copilot/1.0.84-5");
		expect(headers["Editor-Plugin-Version"]).toBeUndefined();
		expect(headers["X-GitHub-Api-Version"]).toBe("2026-08-01");
	});

	it("carries the fixed CLI literals and per-call ids", () => {
		const headers = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(headers["Openai-Intent"]).toBe("conversation-agent");
		expect(headers["X-Interaction-Type"]).toBe("conversation-user");
		expect(headers["Copilot-Harness-Id"]).toBe("copilot-sdk");
		expect(headers["X-Client-Machine-Id"]).toBeTruthy();
		expect(headers["X-Interaction-Id"]).toBeTruthy();
		expect(headers["X-Agent-Task-Id"]).toBeTruthy();
	});

	it("uses the provided sessionId as the client session id", () => {
		const headers = buildCopilotDynamicHeaders({
			messages: userTurn,
			hasImages: false,
			sessionId: "sess-abc",
		});
		expect(headers["X-Client-Session-Id"]).toBe("sess-abc");
	});

	it("keeps a stable machine id across calls but rotates the interaction id per user turn", () => {
		const a = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		const b = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(a["X-Client-Machine-Id"]).toBe(b["X-Client-Machine-Id"]);
		expect(a["X-Interaction-Id"]).not.toBe(b["X-Interaction-Id"]);
	});

	it("keeps interaction and task ids constant across the tool follow-ups of one turn", () => {
		resetCopilotTurnIds();
		const first = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false, sessionId: "session-1" });
		const followUp = buildCopilotDynamicHeaders({ messages: agentTurn, hasImages: false, sessionId: "session-1" });
		expect(followUp["X-Initiator"]).toBe("agent");
		expect(followUp["X-Interaction-Id"]).toBe(first["X-Interaction-Id"]);
		expect(followUp["X-Agent-Task-Id"]).toBe(first["X-Agent-Task-Id"]);
		const nextTurn = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false, sessionId: "session-1" });
		expect(nextTurn["X-Interaction-Id"]).not.toBe(first["X-Interaction-Id"]);
		expect(nextTurn["X-Agent-Task-Id"]).not.toBe(first["X-Agent-Task-Id"]);
		const otherSession = buildCopilotDynamicHeaders({
			messages: agentTurn,
			hasImages: false,
			sessionId: "session-2",
		});
		expect(otherSession["X-Interaction-Id"]).not.toBe(nextTurn["X-Interaction-Id"]);
		resetCopilotTurnIds();
	});

	it("builds the smaller catalog identity without session, task, or SDK headers", () => {
		const headers = buildCopilotCatalogHeaders();
		expect(headers["User-Agent"]).toMatch(/^copilot\/1\.0\.84-5 \(.+\) term\/.+$/);
		expect(headers["User-Agent"]).not.toContain("client/github/cli");
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
		expect(headers["X-Initiator"]).toBe("user");
		expect(headers["Openai-Intent"]).toBe("conversation-agent");
		expect(headers.Accept).toBe("application/json");
		expect(headers["X-Client-Session-Id"]).toBeUndefined();
		expect(headers["X-Agent-Task-Id"]).toBeUndefined();
		expect(headers["X-Stainless-Helper-Method"]).toBeUndefined();
		expect(headers["X-GitHub-Repository-Nwo"]).toBeUndefined();
	});

	it("marks the initiator as user for a user turn and agent for an assistant-led turn", () => {
		expect(inferCopilotInitiator(userTurn)).toBe("user");
		expect(inferCopilotInitiator(agentTurn)).toBe("agent");
		expect(buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false })["X-Initiator"]).toBe("user");
		expect(buildCopilotDynamicHeaders({ messages: agentTurn, hasImages: false })["X-Initiator"]).toBe("agent");
	});

	it("adds the vision header only on image turns", () => {
		const without = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(without["Copilot-Vision-Request"]).toBeUndefined();
		const withImg = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: true });
		expect(withImg["Copilot-Vision-Request"]).toBe("true");
	});

	it("adds the streaming SDK marker unless disabled", () => {
		const streaming = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(streaming["X-Stainless-Helper-Method"]).toBe("stream");
		const nonStreaming = buildCopilotDynamicHeaders({
			messages: userTurn,
			hasImages: false,
			isStreaming: false,
		});
		expect(nonStreaming["X-Stainless-Helper-Method"]).toBeUndefined();
	});

	it("keeps package wire identity stable when COPILOT_CLI_VERSION changes CLI behavior", () => {
		process.env.COPILOT_CLI_VERSION = "9.8.7-test";
		expect(copilotCliVersion()).toBe("1.0.84-5");
		expect(copilotUserAgent()).toMatch(/^copilot\/1\.0\.84-5 /);
	});

	it("honors the official GITHUB_COPILOT_INTEGRATION_ID override", () => {
		process.env.GITHUB_COPILOT_INTEGRATION_ID = "copilot-cli";
		expect(copilotIntegrationId()).toBe("copilot-cli");
		expect(buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false })["Copilot-Integration-Id"]).toBe(
			"copilot-cli",
		);
	});

	it("removes stale catalog identity before dynamic headers are applied", () => {
		const staleHeaders = {
			"Editor-Plugin-Version": "copilot/1.0.81-6",
			"Openai-Intent": "conversation-agent",
			"X-Custom": "keep",
		};
		expect(sanitizeCopilotModelHeaders(staleHeaders, "openai-responses")).toEqual({
			"Openai-Intent": "conversation-agent",
			"X-Custom": "keep",
		});
		expect(sanitizeCopilotModelHeaders(staleHeaders, "anthropic-messages")).toEqual({
			"X-Custom": "keep",
		});
	});

	it("omits OpenAI-only intent on Anthropic requests", () => {
		const headers = buildCopilotDynamicHeaders({
			messages: userTurn,
			hasImages: false,
			api: "anthropic-messages",
		});
		expect(headers["Openai-Intent"]).toBeUndefined();
	});

	it("uses the control-plane user agent without the inference suffix", () => {
		expect(copilotControlPlaneUserAgent()).toMatch(/^copilot\/1\.0\.84-5 /);
		expect(copilotControlPlaneUserAgent()).not.toContain("client/github/cli");
	});

	it("builds a CLI-shaped user agent", () => {
		expect(copilotUserAgent()).toMatch(/^copilot\//);
	});
});
