import { afterEach, describe, expect, it } from "vitest";
import {
	buildCopilotDynamicHeaders,
	copilotIntegrationId,
	copilotUserAgent,
	inferCopilotInitiator,
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
		delete process.env.COPILOT_INTEGRATION_ID;
	});

	it("presents the copilot-developer-cli identity that unlocks the full catalog", () => {
		const headers = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(headers["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
		expect(headers["User-Agent"]).toContain("copilot/");
		expect(headers["Editor-Version"]).toContain("copilot/");
		expect(headers["X-GitHub-Api-Version"]).toBeTruthy();
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

	it("keeps a stable machine id across calls but rotates the interaction id", () => {
		const a = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		const b = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(a["X-Client-Machine-Id"]).toBe(b["X-Client-Machine-Id"]);
		expect(a["X-Interaction-Id"]).not.toBe(b["X-Interaction-Id"]);
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

	it("honors the COPILOT_INTEGRATION_ID override", () => {
		process.env.COPILOT_INTEGRATION_ID = "copilot-cli";
		expect(copilotIntegrationId()).toBe("copilot-cli");
		expect(buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false })["Copilot-Integration-Id"]).toBe(
			"copilot-cli",
		);
	});

	it("builds a CLI-shaped user agent", () => {
		expect(copilotUserAgent()).toMatch(/^copilot\//);
	});
});
