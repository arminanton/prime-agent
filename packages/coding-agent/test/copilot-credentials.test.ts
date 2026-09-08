import { spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	copilotApiModeFromEndpoints,
	copilotPinIdentity,
	copilotPinnedBaseUrl,
	copilotPinnedHost,
	copilotPinnedUser,
	fetchCopilotCatalogInfo,
	hasCopilotPin,
	resolvePinnedCopilotToken,
} from "../src/core/copilot-credentials.js";

vi.mock("child_process", () => ({
	spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

function mockGhToken(token: string, status = 0) {
	spawnSyncMock.mockReturnValue({
		status,
		stdout: token,
		stderr: "",
		pid: 1,
		output: [],
		signal: null,
	} as unknown as ReturnType<typeof spawnSync>);
}

const PIN_VARS = ["COPILOT_GITHUB_TOKEN", "COPILOT_GH_USER", "COPILOT_GH_HOST", "GH_TOKEN", "GITHUB_TOKEN"];

describe("copilot credential pinning", () => {
	beforeEach(() => {
		spawnSyncMock.mockReset();
		for (const v of PIN_VARS) delete process.env[v];
	});
	afterEach(() => {
		for (const v of PIN_VARS) delete process.env[v];
	});

	it("returns an explicit COPILOT_GITHUB_TOKEN verbatim without shelling out", () => {
		process.env.COPILOT_GITHUB_TOKEN = "gho_explicitpin";
		expect(resolvePinnedCopilotToken()).toBe("gho_explicitpin");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("rejects a classic PAT (ghp_) as unusable", () => {
		process.env.COPILOT_GITHUB_TOKEN = "ghp_classicPatNotSupported";
		// Classic PAT is not accepted by the Copilot API; with no user/host pin it
		// falls through to ambient (also none) -> undefined.
		expect(resolvePinnedCopilotToken()).toBeUndefined();
	});

	it("resolves via gh auth token with the pinned user, stripping ambient tokens", () => {
		process.env.COPILOT_GH_USER = "e126380_magh";
		process.env.GH_TOKEN = "gho_ambient_wrong";
		process.env.GITHUB_TOKEN = "gho_ambient_wrong2";
		mockGhToken("gho_pinneduser");

		const token = resolvePinnedCopilotToken();
		expect(token).toBe("gho_pinneduser");

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		const [cmd, args, options] = spawnSyncMock.mock.calls[0];
		expect(cmd).toBe("gh");
		expect(args).toEqual(["auth", "token", "--user", "e126380_magh"]);
		// Ambient tokens must be stripped from the subprocess env so gh reads its
		// own credential store instead of echoing the wrong token back.
		const env = (options as { env?: Record<string, string | undefined> }).env ?? {};
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
	});

	it("passes both --hostname and --user when host and user are pinned", () => {
		process.env.COPILOT_GH_HOST = "ghe.intra.example.com";
		process.env.COPILOT_GH_USER = "William-Anton";
		mockGhToken("gho_enterprise");

		expect(resolvePinnedCopilotToken()).toBe("gho_enterprise");
		const [, args] = spawnSyncMock.mock.calls[0];
		expect(args).toEqual(["auth", "token", "--hostname", "ghe.intra.example.com", "--user", "William-Anton"]);
	});

	it("fails closed when a pin is set but gh returns no usable token", () => {
		process.env.COPILOT_GH_USER = "nonexistent";
		process.env.GH_TOKEN = "gho_ambient_should_not_leak";
		mockGhToken("", 1);
		// Must NOT fall back to the ambient token — that is the whole point.
		expect(resolvePinnedCopilotToken()).toBeUndefined();
	});

	it("falls back to ambient GH_TOKEN only when no pin is configured", () => {
		process.env.GH_TOKEN = "gho_ambient_ok";
		expect(hasCopilotPin()).toBe(false);
		expect(resolvePinnedCopilotToken()).toBe("gho_ambient_ok");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("reports pin state and identity", () => {
		expect(hasCopilotPin()).toBe(false);
		process.env.COPILOT_GH_USER = "e126380_magh";
		process.env.COPILOT_GH_HOST = "github.com";
		expect(hasCopilotPin()).toBe(true);
		expect(copilotPinnedUser()).toBe("e126380_magh");
		expect(copilotPinnedHost()).toBe("github.com");
		expect(copilotPinIdentity()).toBe("github-copilot:pin:github.com:e126380_magh");
	});

	describe("pinned base URL", () => {
		it("is undefined when nothing is pinned", () => {
			expect(copilotPinnedBaseUrl()).toBeUndefined();
		});

		it("is the shared front door for a github.com pin (raw token 421s on the per-plan host)", () => {
			process.env.COPILOT_GH_USER = "e126380_magh";
			expect(copilotPinnedBaseUrl()).toBe("https://api.githubcopilot.com");
		});

		it("is the front door for an explicit token pin too", () => {
			process.env.COPILOT_GITHUB_TOKEN = "gho_explicit";
			expect(copilotPinnedBaseUrl()).toBe("https://api.githubcopilot.com");
		});

		it("is the enterprise Copilot host when an enterprise host is pinned", () => {
			process.env.COPILOT_GH_HOST = "ghe.intra.example.com";
			expect(copilotPinnedBaseUrl()).toBe("https://copilot-api.ghe.intra.example.com");
		});
	});
});

describe("copilot api-mode routing from supported_endpoints", () => {
	it("routes /v1/messages to anthropic-messages (Claude)", () => {
		expect(copilotApiModeFromEndpoints(["/v1/messages", "/chat/completions"])).toBe("anthropic-messages");
	});

	it("routes /responses-only models to openai-responses (grok, mai-code)", () => {
		expect(copilotApiModeFromEndpoints(["/responses"])).toBe("openai-responses");
		expect(copilotApiModeFromEndpoints(["/responses", "ws:/responses"])).toBe("openai-responses");
	});

	it("prefers responses when both responses and completions are offered (gpt-5.4)", () => {
		expect(copilotApiModeFromEndpoints(["/responses", "/chat/completions", "ws:/responses"])).toBe(
			"openai-responses",
		);
	});

	it("routes completions-only models to openai-completions (Gemini)", () => {
		expect(copilotApiModeFromEndpoints(["/chat/completions"])).toBe("openai-completions");
	});

	it("returns undefined when no known endpoint is present", () => {
		expect(copilotApiModeFromEndpoints([])).toBeUndefined();
		expect(copilotApiModeFromEndpoints(["/embeddings"])).toBeUndefined();
	});
});

describe("fetchCopilotCatalogInfo", () => {
	function mockModelsResponse(
		models: Array<{
			id: string;
			supported_endpoints?: string[];
			policy?: { state: "enabled" | "disabled" | "unconfigured" };
		}>,
	): typeof fetch {
		return (async () =>
			new Response(JSON.stringify({ data: models }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
	}

	it("uses the per-plan API host embedded in a stored OAuth token", async () => {
		let requestedUrl = "";
		await fetchCopilotCatalogInfo("tid=test;proxy-ep=proxy.business.githubcopilot.com;", {
			fetchFn: (async (input: string | URL | Request) => {
				requestedUrl = String(input);
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as typeof fetch,
		});

		expect(requestedUrl).toBe("https://api.business.githubcopilot.com/models");
	});

	it("returns entitled ids and per-model api routing from supported_endpoints", async () => {
		const info = await fetchCopilotCatalogInfo("gho_test", {
			baseUrl: "https://api.githubcopilot.com",
			fetchFn: mockModelsResponse([
				{ id: "claude-opus-4.8", supported_endpoints: ["/v1/messages", "/chat/completions"] },
				{ id: "grok-4.6", supported_endpoints: ["/responses"] },
				{ id: "mai-code-1.1-flash", supported_endpoints: ["/responses"] },
				{ id: "gemini-3.5-flash", supported_endpoints: ["/chat/completions"] },
				{ id: "gpt-5.5", supported_endpoints: ["/responses", "ws:/responses"] },
			]),
		});
		expect(info.catalogAvailable).toBe(true);
		expect([...info.ids].sort()).toEqual([
			"claude-opus-4.8",
			"gemini-3.5-flash",
			"gpt-5.5",
			"grok-4.6",
			"mai-code-1.1-flash",
		]);
		expect(info.apiById.get("claude-opus-4.8")).toBe("anthropic-messages");
		expect(info.apiById.get("grok-4.6")).toBe("openai-responses");
		expect(info.apiById.get("mai-code-1.1-flash")).toBe("openai-responses");
		expect(info.apiById.get("gemini-3.5-flash")).toBe("openai-completions");
		expect(info.apiById.get("gpt-5.5")).toBe("openai-responses");
	});

	it("excludes models whose live policy is disabled or unconfigured", async () => {
		const info = await fetchCopilotCatalogInfo("gho_test", {
			baseUrl: "https://api.githubcopilot.com",
			fetchFn: mockModelsResponse([
				{ id: "enabled", policy: { state: "enabled" }, supported_endpoints: ["/responses"] },
				{ id: "unconfigured", policy: { state: "unconfigured" }, supported_endpoints: ["/responses"] },
				{ id: "disabled", policy: { state: "disabled" }, supported_endpoints: ["/responses"] },
			]),
		});

		expect(info.catalogAvailable).toBe(true);
		expect([...info.ids]).toEqual(["enabled"]);
		expect([...info.apiById.keys()]).toEqual(["enabled"]);
	});

	it("returns empty structures on a non-200 (caller keeps the full catalog)", async () => {
		const info = await fetchCopilotCatalogInfo("gho_test", {
			baseUrl: "https://api.githubcopilot.com",
			fetchFn: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
		});
		expect(info.catalogAvailable).toBe(false);
		expect(info.ids.size).toBe(0);
		expect(info.apiById.size).toBe(0);
	});

	it("tolerates entries without supported_endpoints (id kept, no routing override)", async () => {
		const info = await fetchCopilotCatalogInfo("gho_test", {
			baseUrl: "https://api.githubcopilot.com",
			fetchFn: mockModelsResponse([{ id: "some-model" }]),
		});
		expect([...info.ids]).toEqual(["some-model"]);
		expect(info.apiById.has("some-model")).toBe(false);
	});
});
