import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDaemonScopeInvocation } from "../src/cli/daemon-launch.js";

// A.1 launcher scope: opt-in, reversible, and falls back cleanly when systemd-run is absent.

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	originalEnv = { ...process.env };
	tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-scope-"));
	delete process.env.PRIME_AGENT_DAEMON_SCOPE;
	delete process.env.PRIME_AGENT_DAEMON_SCOPE_MEMORY_MAX;
	delete process.env.PRIME_AGENT_DAEMON_SCOPE_MEMORY_SWAP_MAX;
});

afterEach(() => {
	process.env = originalEnv;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = "";
	}
});

function installFakeSystemdRun(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const path = join(binDir, "systemd-run");
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	process.env.PATH = binDir;
	return path;
}

describe("buildDaemonScopeInvocation", () => {
	it("is a no-op passthrough when PRIME_AGENT_DAEMON_SCOPE is unset", () => {
		const invocation = buildDaemonScopeInvocation("/usr/bin/node", ["--mode", "daemon"]);
		expect(invocation).toEqual({ command: "/usr/bin/node", args: ["--mode", "daemon"], scoped: false });
	});

	it("wraps the launch in a systemd --user scope with hard memory + swap caps when enabled", () => {
		const systemdRun = installFakeSystemdRun();
		process.env.PRIME_AGENT_DAEMON_SCOPE = "1";

		const invocation = buildDaemonScopeInvocation("/usr/bin/node", ["--mode", "daemon", "--daemon-socket", "/s.sock"]);

		expect(invocation.scoped).toBe(true);
		expect(invocation.warning).toBeUndefined();
		expect(invocation.command).toBe(systemdRun);
		expect(invocation.args).toEqual([
			"--user",
			"--scope",
			"--collect",
			"--unit=prime-agent-daemon",
			"-p",
			"MemoryMax=46G",
			"-p",
			"MemorySwapMax=6G",
			"-p",
			"Delegate=yes",
			"--",
			"/usr/bin/node",
			"--mode",
			"daemon",
			"--daemon-socket",
			"/s.sock",
		]);
	});

	it("honors MemoryMax and MemorySwapMax overrides", () => {
		installFakeSystemdRun();
		process.env.PRIME_AGENT_DAEMON_SCOPE = "1";
		process.env.PRIME_AGENT_DAEMON_SCOPE_MEMORY_MAX = "40G";
		process.env.PRIME_AGENT_DAEMON_SCOPE_MEMORY_SWAP_MAX = "4G";

		const invocation = buildDaemonScopeInvocation("/usr/bin/node", []);
		expect(invocation.args).toContain("MemoryMax=40G");
		expect(invocation.args).toContain("MemorySwapMax=4G");
	});

	it("falls back to the unscoped launch with a warning when systemd-run is missing", () => {
		process.env.PRIME_AGENT_DAEMON_SCOPE = "1";
		process.env.PATH = join(tempDir, "empty");

		const invocation = buildDaemonScopeInvocation("/usr/bin/node", ["--mode", "daemon"]);
		expect(invocation.scoped).toBe(false);
		expect(invocation.command).toBe("/usr/bin/node");
		expect(invocation.args).toEqual(["--mode", "daemon"]);
		expect(invocation.warning).toMatch(/systemd-run was not found/);
	});
});
