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
	delete process.env.PRIME_AGENT_DAEMON_SLICE;
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

	it("wraps the launch in an auto-named scope under the capped parent slice when enabled", () => {
		const systemdRun = installFakeSystemdRun();
		process.env.PRIME_AGENT_DAEMON_SCOPE = "1";

		const invocation = buildDaemonScopeInvocation("/usr/bin/node", ["--mode", "daemon", "--daemon-socket", "/s.sock"]);

		expect(invocation.scoped).toBe(true);
		expect(invocation.warning).toBeUndefined();
		expect(invocation.command).toBe(systemdRun);
		// Auto-named scope (no fixed --unit that would collide on restart) under the fixed capped
		// parent slice; caps live on the slice (set once by the deploy), not on the scope.
		expect(invocation.args).toEqual([
			"--user",
			"--scope",
			"--slice=prime-agent.slice",
			"--collect",
			"--",
			"/usr/bin/node",
			"--mode",
			"daemon",
			"--daemon-socket",
			"/s.sock",
		]);
		expect(invocation.args.some((arg) => arg.startsWith("--unit="))).toBe(false);
		expect(invocation.args.some((arg) => arg.startsWith("MemoryMax="))).toBe(false);
	});

	it("honors a PRIME_AGENT_DAEMON_SLICE override", () => {
		installFakeSystemdRun();
		process.env.PRIME_AGENT_DAEMON_SCOPE = "1";
		process.env.PRIME_AGENT_DAEMON_SLICE = "prime-agent-test.slice";

		const invocation = buildDaemonScopeInvocation("/usr/bin/node", []);
		expect(invocation.args).toContain("--slice=prime-agent-test.slice");
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

	it("falls back to the unscoped launch when systemd-run is present but not executable", () => {
		const binDir = join(tempDir, "bin");
		mkdirSync(binDir, { recursive: true });
		// Present on PATH but NOT executable (mode 0644): a bare presence check would pick it and
		// then fail at spawn; the X_OK check must treat it as not found and fall back.
		writeFileSync(join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(binDir, "systemd-run"), 0o644);
		process.env.PATH = binDir;
		process.env.PRIME_AGENT_DAEMON_SCOPE = "1";

		const invocation = buildDaemonScopeInvocation("/usr/bin/node", ["--mode", "daemon"]);
		expect(invocation.scoped).toBe(false);
		expect(invocation.command).toBe("/usr/bin/node");
		expect(invocation.warning).toMatch(/systemd-run was not found/);
	});
});
