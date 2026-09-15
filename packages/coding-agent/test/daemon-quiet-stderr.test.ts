import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDaemonLogPath } from "../src/config.js";
import { DAEMON_QUIET_STDERR_ENV } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

// A.1 M7: the auto-launched detached supervisor suppresses the duplicate console.error to its
// inherited stderr FD (so it never grows the FD the launcher points at the rotated log), while the
// rotating daemon log stays authoritative. A manual foreground `--mode daemon` run keeps stderr.

describe("daemon supervisor quiet stderr (A.1 M7)", () => {
	let tempDir = "";
	let originalHome: string | undefined;
	let originalQuiet: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-quiet-"));
		originalHome = process.env.HOME;
		originalQuiet = process.env[DAEMON_QUIET_STDERR_ENV];
		process.env.HOME = tempDir;
		delete process.env[DAEMON_QUIET_STDERR_ENV];
		// The real daemon installs a file log sink (installFileLogSink), so structuredLog.warn never
		// falls back to console.error. Mirror that so this test isolates the log()-gated stderr write.
		setLogSink(() => {});
	});

	afterEach(() => {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalQuiet === undefined) delete process.env[DAEMON_QUIET_STDERR_ENV];
		else process.env[DAEMON_QUIET_STDERR_ENV] = originalQuiet;
		vi.restoreAllMocks();
		setLogSink(undefined);
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function makeSupervisor(): { socketPath: string; log(message: string): void } {
		return Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			socketPath: join(tempDir, "daemon.sock"),
		}) as unknown as { socketPath: string; log(message: string): void };
	}

	it("suppresses console.error but still writes the rotating daemon log when quiet is set", () => {
		const sup = makeSupervisor();
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env[DAEMON_QUIET_STDERR_ENV] = "1";

		sup.log("quiet-message");

		expect(spy).not.toHaveBeenCalled();
		const logPath = getDaemonLogPath(sup.socketPath);
		expect(existsSync(logPath)).toBe(true);
		expect(readFileSync(logPath, "utf8")).toContain("quiet-message");
	});

	it("keeps console.error for a manual foreground run (quiet env unset)", () => {
		const sup = makeSupervisor();
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		sup.log("foreground-message");

		expect(spy).toHaveBeenCalledWith("foreground-message");
	});
});
