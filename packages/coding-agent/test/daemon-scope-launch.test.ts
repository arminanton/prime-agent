import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildDaemonScopeInvocation,
	type DaemonLaunchAttempt,
	type DaemonLaunchInvocation,
	launchDaemonWithScopedFallback,
} from "../src/cli/daemon-launch.js";

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


// A.1 M5: the scoped -> unscoped fallback retries ONLY on a confirmed early exit / spawn failure of
// the scoped child, never on a live-child timeout (which would double-spawn a daemon and could lose
// the lease + cgroup containment). The launch step is injected so no real process is spawned.
describe("launchDaemonWithScopedFallback", () => {
	const scoped: DaemonLaunchInvocation = { command: "systemd-run", args: ["--scope"], scoped: true };
	const buildUnscoped = (): DaemonLaunchInvocation => ({ command: "node", args: ["--mode", "daemon"], scoped: false });
	const silent = () => {};

	it("retries UNSCOPED exactly once on a confirmed nonzero early exit, then succeeds", async () => {
		const calls: DaemonLaunchInvocation[] = [];
		const results: DaemonLaunchAttempt[] = [
			{ started: false, childExited: true, spawnError: false, message: "daemon exited during startup (code 1)" },
			{ started: true },
		];
		const launch = async (invocation: DaemonLaunchInvocation): Promise<DaemonLaunchAttempt> => {
			calls.push(invocation);
			return results.shift()!;
		};

		await launchDaemonWithScopedFallback(scoped, buildUnscoped, launch, silent);

		expect(calls.map((c) => c.scoped)).toEqual([true, false]);
	});

	it("retries UNSCOPED on a scoped spawn failure (systemd-run not spawnable)", async () => {
		const calls: DaemonLaunchInvocation[] = [];
		const results: DaemonLaunchAttempt[] = [
			{ started: false, childExited: false, spawnError: true, message: "Failed to spawn Prime Agent daemon" },
			{ started: true },
		];
		const launch = async (invocation: DaemonLaunchInvocation): Promise<DaemonLaunchAttempt> => {
			calls.push(invocation);
			return results.shift()!;
		};

		await launchDaemonWithScopedFallback(scoped, buildUnscoped, launch, silent);

		expect(calls.map((c) => c.scoped)).toEqual([true, false]);
	});

	it("does not retry more than once even when the unscoped fallback also fails", async () => {
		let count = 0;
		const launch = async (invocation: DaemonLaunchInvocation): Promise<DaemonLaunchAttempt> => {
			count += 1;
			return invocation.scoped
				? { started: false, childExited: true, spawnError: false, message: "scoped early exit" }
				: { started: false, childExited: true, spawnError: false, message: "unscoped early exit" };
		};

		await expect(launchDaemonWithScopedFallback(scoped, buildUnscoped, launch, silent)).rejects.toThrow(
			/unscoped early exit/,
		);
		expect(count).toBe(2);
	});

	it("does NOT spawn a second daemon on a live-child timeout (fail-closed)", async () => {
		const calls: DaemonLaunchInvocation[] = [];
		const launch = async (invocation: DaemonLaunchInvocation): Promise<DaemonLaunchAttempt> => {
			calls.push(invocation);
			// childExited=false + spawnError=false is the live-child timeout: the scoped daemon is
			// still alive and likely still booting.
			return { started: false, childExited: false, spawnError: false, message: "Timed out waiting for daemon to start" };
		};

		await expect(launchDaemonWithScopedFallback(scoped, buildUnscoped, launch, silent)).rejects.toThrow(/Timed out/);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.scoped).toBe(true);
	});

	it("an already-unscoped launch failure never retries", async () => {
		let count = 0;
		const launch = async (): Promise<DaemonLaunchAttempt> => {
			count += 1;
			return { started: false, childExited: true, spawnError: false, message: "boom" };
		};

		await expect(
			launchDaemonWithScopedFallback(buildUnscoped(), buildUnscoped, launch, silent),
		).rejects.toThrow(/boom/);
		expect(count).toBe(1);
	});
});
