import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCopilotCatalogHeaders, buildCopilotDynamicHeaders } from "../src/providers/github-copilot-headers.js";
import type { Message } from "../src/types.js";

const userTurn: Message[] = [{ role: "user", content: "hi", timestamp: 0 }];
const toolTurn: Message[] = [
	{ role: "toolResult", toolCallId: "call-1", toolName: "lookup", content: [], isError: false, timestamp: 0 },
];

describe("GitHub Copilot request identity", () => {
	beforeEach(() => {
		for (const key of [
			"GITHUB_COPILOT_INTEGRATION_ID",
			"COPILOT_API_VERSION",
			"COPILOT_NODE_VERSION",
			"COPILOT_MACHINE_ID",
			"COPILOT_TERM_PROGRAM",
			"TERM_PROGRAM",
		]) {
			vi.stubEnv(key, undefined);
		}
	});
	afterEach(() => vi.unstubAllEnvs());

	it("uses the CLI identity instead of VS Code Chat", () => {
		const headers = buildCopilotDynamicHeaders({ messages: userTurn, hasImages: false });
		expect(headers).toMatchObject({
			"User-Agent": `copilot/1.0.84-5 (${process.platform} v24.20.0) term/unknown client/github/cli`,
			"Editor-Version": "copilot/1.0.84-5",
			"Copilot-Integration-Id": "copilot-developer-cli",
			"X-GitHub-Api-Version": "2026-08-01",
			"Openai-Intent": "conversation-agent",
			"X-Initiator": "user",
			"X-Interaction-Type": "conversation-user",
			"Copilot-Harness-Id": "copilot-sdk",
			"X-Stainless-Helper-Method": "stream",
		});
		expect(headers).not.toHaveProperty("Editor-Plugin-Version");
		expect(headers).not.toHaveProperty("Copilot-Vision-Request");
	});

	it("reuses turn identifiers for tool follow-ups but not the next user turn", () => {
		const params = { hasImages: false, sessionId: "header-turn-test" };
		const first = buildCopilotDynamicHeaders({ ...params, messages: userTurn });
		const followUp = buildCopilotDynamicHeaders({ ...params, messages: toolTurn });
		const nextTurn = buildCopilotDynamicHeaders({ ...params, messages: userTurn });
		expect(followUp["X-Initiator"]).toBe("agent");
		for (const key of ["X-Interaction-Id", "X-Agent-Task-Id"]) {
			expect(first[key]).toMatch(/^[0-9a-f-]{36}$/);
			expect(followUp[key]).toBe(first[key]);
			expect(nextTurn[key]).not.toBe(first[key]);
		}
		expect(nextTurn["X-Client-Session-Id"]).toBe(params.sessionId);
		expect(nextTurn["X-Client-Machine-Id"]).toBe(first["X-Client-Machine-Id"]);
	});

	it("omits OpenAI intent on Anthropic requests and stream markers on JSON requests", () => {
		const headers = buildCopilotDynamicHeaders({
			messages: userTurn,
			hasImages: true,
			api: "anthropic-messages",
			isStreaming: false,
		});
		expect(headers["Copilot-Vision-Request"]).toBe("true");
		expect(headers).not.toHaveProperty("Openai-Intent");
		expect(headers).not.toHaveProperty("X-Stainless-Helper-Method");
	});

	it("keeps catalog headers independent of inference sessions", () => {
		const headers = buildCopilotCatalogHeaders();
		expect(headers).toMatchObject({
			"User-Agent": `copilot/1.0.84-5 (${process.platform} v24.20.0) term/unknown`,
			"Copilot-Integration-Id": "copilot-developer-cli",
			"X-GitHub-Api-Version": "2026-08-01",
			Accept: "application/json",
		});
		for (const key of [
			"X-Client-Session-Id",
			"X-Agent-Task-Id",
			"X-Stainless-Helper-Method",
			"X-GitHub-Repository-Nwo",
		]) {
			expect(headers).not.toHaveProperty(key);
		}
	});

	it("reads environment overrides per call without changing package identity", () => {
		vi.stubEnv("GITHUB_COPILOT_INTEGRATION_ID", "copilot-cli");
		vi.stubEnv("COPILOT_API_VERSION", "2026-07-01");
		vi.stubEnv("COPILOT_NODE_VERSION", "24.20.1");
		vi.stubEnv("COPILOT_MACHINE_ID", "test-machine");
		vi.stubEnv("COPILOT_TERM_PROGRAM", "test-terminal");
		vi.stubEnv("COPILOT_CLI_VERSION", "test-version");
		expect(buildCopilotCatalogHeaders()).toMatchObject({
			"User-Agent": `copilot/1.0.84-5 (${process.platform} v24.20.1) term/test-terminal`,
			"Copilot-Integration-Id": "copilot-cli",
			"X-GitHub-Api-Version": "2026-07-01",
			"X-Client-Machine-Id": "test-machine",
		});
	});
});
