import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";

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

describe("AuthStorage GitHub Copilot pinning", () => {
	let tempDir: string;
	let authJsonPath: string;

	beforeEach(() => {
		spawnSyncMock.mockReset();
		for (const v of PIN_VARS) delete process.env[v];
		tempDir = join(tmpdir(), `pi-test-copilot-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		for (const v of PIN_VARS) delete process.env[v];
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		vi.restoreAllMocks();
	});

	it("resolves the pinned account token over an ambient GH_TOKEN", async () => {
		process.env.COPILOT_GH_USER = "e126380_magh";
		process.env.GH_TOKEN = "gho_ambient_wrong_account";
		mockGhToken("gho_pinned_correct_account");

		const storage = AuthStorage.create(authJsonPath);
		const apiKey = await storage.getApiKey("github-copilot");

		expect(apiKey).toBe("gho_pinned_correct_account");
		const [cmd, args] = spawnSyncMock.mock.calls[0];
		expect(cmd).toBe("gh");
		expect(args).toContain("--user");
		expect(args).toContain("e126380_magh");
	});

	it("prefers an explicit COPILOT_GITHUB_TOKEN over a stored auth.json credential", async () => {
		process.env.COPILOT_GITHUB_TOKEN = "gho_explicit_pin";
		writeFileSync(
			authJsonPath,
			JSON.stringify({
				"github-copilot": { type: "api_key", key: "gho_stored_in_auth_json" },
			}),
		);

		const storage = AuthStorage.create(authJsonPath);
		const apiKey = await storage.getApiKey("github-copilot");

		expect(apiKey).toBe("gho_explicit_pin");
		// Explicit token short-circuits before shelling out to gh.
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("fails closed when a pin is set but gh cannot resolve it (no ambient leak)", async () => {
		process.env.COPILOT_GH_USER = "nonexistent_account";
		process.env.GH_TOKEN = "gho_ambient_must_not_leak";
		mockGhToken("", 1);

		const storage = AuthStorage.create(authJsonPath);
		const apiKey = await storage.getApiKey("github-copilot");

		expect(apiKey).toBeUndefined();
	});

	it("leaves resolution unchanged for other providers", async () => {
		process.env.COPILOT_GH_USER = "e126380_magh";
		writeFileSync(
			authJsonPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: "sk-ant-untouched" },
			}),
		);

		const storage = AuthStorage.create(authJsonPath);
		const apiKey = await storage.getApiKey("anthropic");

		expect(apiKey).toBe("sk-ant-untouched");
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});
});
