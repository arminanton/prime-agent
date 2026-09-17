import { afterEach, describe, expect, it, vi } from "vitest";
import { loginAnthropic, refreshAnthropicToken } from "../src/utils/oauth/anthropic.js";
import { loginGitHubCopilot } from "../src/utils/oauth/github-copilot.js";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function getUrl(input: unknown): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	if (input instanceof Request) {
		return input.url;
	}
	throw new Error(`Unsupported fetch input: ${String(input)}`);
}

describe("GitHub Copilot OAuth device flow", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("waits before the first poll and increases the safety margin after slow_down", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
			jsonResponse({ error: "slow_down", error_description: "slow down", interval: 10 }),
			jsonResponse({ access_token: "ghu_refresh_token" }),
		];

		const fetchMock = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": expect.stringMatching(/^copilot\/1\.0\.84-5 /),
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("scope=read%3Auser");
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 900,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
				});
				expect(String(init?.body)).toContain("client_id=");
				expect(String(init?.body)).toContain("device_code=device-code");
				expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
				const response = accessTokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra access token poll");
				}
				return response;
			}

			if (url.includes("/copilot_internal/v2/token")) {
				expect(init?.headers).toMatchObject({
					"User-Agent": expect.stringMatching(/^copilot\/1\.0\.84-5 /),
					"Editor-Version": "copilot/1.0.84-5",
					"Copilot-Integration-Id": "copilot-developer-cli",
				});
				expect(init?.headers).not.toHaveProperty("Editor-Plugin-Version");
				return jsonResponse({
					token: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires_at: 9999999999,
				});
			}

			if (url.endsWith("/models")) {
				return jsonResponse({
					data: [
						{ id: "live-enabled", policy: { state: "enabled" } },
						{ id: "needs/policy", policy: { state: "unconfigured", terms: "https://terms.example/model" } },
					],
				});
			}

			if (url.includes("/models/") && url.endsWith("/policy")) {
				return new Response("", { status: 200 });
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const prompts: string[] = [];
		const loginPromise = loginGitHubCopilot({
			onAuth: () => {},
			onPrompt: async ({ message }) => {
				prompts.push(message);
				return message.startsWith("GitHub Enterprise") ? "" : "yes";
			},
			onProgress: () => {},
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(accessTokenPollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(5999);
		expect(accessTokenPollTimes).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5999);
		expect(accessTokenPollTimes).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(accessTokenPollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(13999);
		expect(accessTokenPollTimes).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		await loginPromise;

		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("needs/policy");
		expect(prompts[1]).toContain("https://terms.example/model");
		const catalogCalls = fetchMock.mock.calls.filter(([input]) => getUrl(input).endsWith("/models"));
		expect(catalogCalls).toHaveLength(1);
		expect(catalogCalls[0][1]?.headers).toMatchObject({
			"Copilot-Integration-Id": "copilot-developer-cli",
			"Copilot-Harness-Id": "copilot-sdk",
			"X-GitHub-Api-Version": "2026-08-01",
			"User-Agent": expect.stringMatching(/^copilot\/1\.0\.84-5 \(.+\) term\/[^ ]+$/),
		});
		const policyCalls = fetchMock.mock.calls.filter(([input]) => getUrl(input).endsWith("/policy"));
		expect(policyCalls).toHaveLength(1);
		expect(getUrl(policyCalls[0][0])).toContain("/models/needs%2Fpolicy/policy");
		expect(policyCalls[0][1]?.method).toBe("POST");
		expect(JSON.parse(String(policyCalls[0][1]?.body))).toEqual({ state: "enabled" });

		expect(accessTokenPollTimes).toEqual([
			startTime.getTime() + 6000,
			startTime.getTime() + 12000,
			startTime.getTime() + 26000,
		]);
	});

	it.each([
		{ state: "unconfigured", answer: "no", prompts: 2 },
		{ state: "unconfigured", answer: "", prompts: 2 },
		{ state: "disabled", answer: "yes", prompts: 1 },
		{ state: "enabled", answer: "yes", prompts: 1 },
		{ state: undefined, answer: "yes", prompts: 1 },
	])("does not enable a $state model after answering '$answer'", async ({ state, answer, prompts }) => {
		vi.useFakeTimers();
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown): Promise<Response> => {
			const url = getUrl(input);
			requests.push(url);
			if (url.endsWith("/login/device/code"))
				return jsonResponse({
					device_code: "test-device",
					user_code: "TEST-CODE",
					verification_uri: "https://github.com/login/device",
					interval: 1,
					expires_in: 60,
				});
			if (url.endsWith("/login/oauth/access_token")) return jsonResponse({ access_token: "gho_test_refresh" });
			if (url.endsWith("/copilot_internal/v2/token"))
				return jsonResponse({ token: "test-copilot-token", expires_at: 9999999999 });
			if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "test-model", policy: { state } }] });
			return jsonResponse({});
		});
		let promptCount = 0;
		const login = loginGitHubCopilot({
			onAuth: () => {},
			onPrompt: async () => (++promptCount === 1 ? "" : answer),
		});
		await vi.runAllTimersAsync();
		expect(await login).toMatchObject({ refresh: "gho_test_refresh", access: "test-copilot-token" });
		expect(promptCount).toBe(prompts);
		expect(requests.filter((url) => url.endsWith("/policy"))).toEqual([]);
	});

	it("uses the remaining lifetime for a final poll before timing out after repeated slow_down responses", async () => {
		vi.useFakeTimers();
		const startTime = new Date("2026-03-09T00:00:00Z");
		vi.setSystemTime(startTime);

		const accessTokenPollTimes: number[] = [];
		const accessTokenResponses = [
			jsonResponse({ error: "slow_down", error_description: "slow down", interval: 10 }),
			jsonResponse({ error: "slow_down", error_description: "still too fast", interval: 15 }),
			jsonResponse({ error: "authorization_pending", error_description: "pending" }),
		];

		const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
			const url = getUrl(input);

			if (url.endsWith("/login/device/code")) {
				return jsonResponse({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					interval: 5,
					expires_in: 25,
				});
			}

			if (url.endsWith("/login/oauth/access_token")) {
				accessTokenPollTimes.push(Date.now());
				const response = accessTokenResponses.shift();
				if (!response) {
					throw new Error("Unexpected extra access token poll");
				}
				return response;
			}

			throw new Error(`Unexpected fetch URL: ${url}`);
		});

		vi.stubGlobal("fetch", fetchMock);

		const loginPromise = loginGitHubCopilot({
			onAuth: () => {},
			onPrompt: async () => "",
		});
		const rejection = expect(loginPromise).rejects.toThrow(
			/Device flow timed out after one or more slow_down responses/,
		);

		await vi.advanceTimersByTimeAsync(6000);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 6000]);

		await vi.advanceTimersByTimeAsync(14000);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 6000, startTime.getTime() + 20000]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(accessTokenPollTimes).toEqual([startTime.getTime() + 6000, startTime.getTime() + 20000]);

		await vi.advanceTimersByTimeAsync(1);
		await rejection;

		expect(accessTokenPollTimes).toEqual([
			startTime.getTime() + 6000,
			startTime.getTime() + 20000,
			startTime.getTime() + 25000,
		]);
	});
});

function getJsonBody(init?: RequestInit): Record<string, string> {
	if (typeof init?.body !== "string") {
		throw new Error(`Expected string request body, got ${typeof init?.body}`);
	}
	return JSON.parse(init.body) as Record<string, string>;
}

describe.sequential("Anthropic OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the localhost redirect_uri for manual callback login", async () => {
		let authUrl = "";
		const requests: Record<string, string>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
				expect(init?.method).toBe("POST");
				requests.push(getJsonBody(init));
				return jsonResponse({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600 });
			}),
		);

		const credentials = await loginAnthropic({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				if (!state || !redirectUri) throw new Error("Missing OAuth state or redirect_uri in auth URL");
				return `${redirectUri}?code=manual-code&state=${state}`;
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			grant_type: "authorization_code",
			code: "manual-code",
			redirect_uri: "http://localhost:53692/callback",
		});
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
	});

	it("omits scope from refresh token requests", async () => {
		const requests: Record<string, string>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				expect(getUrl(input)).toBe("https://platform.claude.com/v1/oauth/token");
				requests.push(getJsonBody(init));
				return jsonResponse({
					access_token: "new-access-token",
					refresh_token: "new-refresh-token",
					expires_in: 3600,
				});
			}),
		);

		const credentials = await refreshAnthropicToken("refresh-token");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-token" });
		expect(requests[0].client_id).toBeTruthy();
		expect(requests[0]).not.toHaveProperty("scope");
		expect(credentials.access).toBe("new-access-token");
		expect(credentials.refresh).toBe("new-refresh-token");
	});
});

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (): Promise<Response> =>
					jsonResponse(
						{
							error: {
								message: "Could not validate your token. Please try signing in again.",
								type: "invalid_request_error",
							},
						},
						401,
					),
			),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});
});
