import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { manifestPathIn, snapshotPathIn } from "../src/core/kernel/state-snapshot.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

// Lazy kernel prewarm (A.5). A daemon-hydrated passive session (e.g. a woken subagent
// child) must not eagerly start a Python kernel and restore its pickle at build time; it
// defers to the first actual ipython use. Interactive/main agents still prewarm. The gate
// decision is exercised directly on a partial session instance.

interface PrewarmHandle {
	_prewarmIpythonKernel: boolean;
	_shouldEagerPrewarmKernel(hasSnapshot: boolean): boolean;
}

function makeSession(prewarm: boolean): PrewarmHandle {
	return Object.assign(Object.create(AgentSession.prototype) as object, {
		_prewarmIpythonKernel: prewarm,
	}) as unknown as PrewarmHandle;
}

const ENV = "PRIME_AGENT_EAGER_KERNEL_PREWARM_ON_HYDRATE";

describe("lazy kernel prewarm (A.5)", () => {
	afterEach(() => {
		delete process.env[ENV];
	});

	it("interactive/main agents prewarm regardless of snapshot or env", () => {
		const session = makeSession(true);
		expect(session._shouldEagerPrewarmKernel(false)).toBe(true);
		expect(session._shouldEagerPrewarmKernel(true)).toBe(true);
	});

	it("a passive snapshot-bearing session defers by default (no eager kernel start)", () => {
		const session = makeSession(false);
		expect(session._shouldEagerPrewarmKernel(true)).toBe(false);
		expect(session._shouldEagerPrewarmKernel(false)).toBe(false);
	});

	it("the env switch restores eager on-hydrate prewarm for a snapshot-bearing session", () => {
		const session = makeSession(false);
		process.env[ENV] = "1";
		expect(session._shouldEagerPrewarmKernel(true)).toBe(true);
		// There is still nothing to prewarm without a snapshot.
		expect(session._shouldEagerPrewarmKernel(false)).toBe(false);
	});
});


// A minimal successful rlm.repl fake: it records each process start, completes the handshake,
// and returns status ok for restore / bootstrap execute / snapshot / shutdown, so ensure()
// resolves and is memoized (unlike the failure fakes elsewhere).
function writeSuccessfulReplRuntime(dir: string): { python: string; countStarts: () => number } {
	const python = join(dir, "python-repl-ok");
	const countFile = join(dir, "starts");
	writeFileSync(
		python,
		`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(countFile)}, "start\\n");
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ event: "ready", protocol: 3, python: process.version });
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "restore") {
		emit({ event: "done", id: request.id, status: "ok", restored: ["revived_name"], failed: [] });
		return;
	}
	if (request.type === "snapshot") {
		emit({ event: "done", id: request.id, status: "ok", saved: [], skipped: [], bytes: 0 });
		return;
	}
	if (request.type === "execute") {
		emit({ event: "done", id: request.id, status: "ok" });
		return;
	}
	if (request.type === "shutdown") {
		emit({ event: "done", id: request.id, status: "ok" });
		process.exit(0);
	}
});
`,
	);
	chmodSync(python, 0o755);
	const countStarts = () => {
		try {
			return readFileSync(countFile, "utf8").split("\n").filter(Boolean).length;
		} catch {
			return 0;
		}
	};
	return { python, countStarts };
}

describe("lazy kernel prewarm provisioner integration (A.5)", () => {
	let tempDir = "";
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-a5-hydrate-"));
	});
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("a passive child hydration starts no kernel until the first tool cell, then exactly one", async () => {
		const snapshotDir = join(tempDir, "artifacts");
		mkdirSync(snapshotDir, { recursive: true });
		// A prior session's snapshot exists (a woken child WITH state), the memory-wave case.
		writeFileSync(snapshotPathIn(snapshotDir), "snapshot-bytes");
		writeFileSync(manifestPathIn(snapshotDir), JSON.stringify({ names: ["revived_name"] }));
		const { python, countStarts } = writeSuccessfulReplRuntime(tempDir);

		const provisioner = new IpythonKernelProvisioner(tempDir, { python, snapshotDir });
		try {
			// Passive hydration: the session decided NOT to prewarm, so nothing has started a kernel.
			expect(countStarts()).toBe(0);
			expect(provisioner.manager).toBeUndefined();
			expect(provisioner.hasRunningKernel).toBe(false);

			// First tool cell: ensure() starts (and snapshot-restores) exactly one kernel.
			await provisioner.ensure();
			expect(countStarts()).toBe(1);
			expect(provisioner.hasRunningKernel).toBe(true);
			expect(provisioner.lastRestore?.restored).toContain("revived_name");

			// A later tool cell reuses the same kernel: no second start.
			await provisioner.ensure();
			expect(countStarts()).toBe(1);
		} finally {
			await provisioner.dispose({ snapshot: false });
		}
	});

	it("an interactive/root prewarm starts exactly one kernel eagerly (behavior unchanged)", async () => {
		const { python, countStarts } = writeSuccessfulReplRuntime(tempDir);
		const provisioner = new IpythonKernelProvisioner(tempDir, { python });
		try {
			// Interactive frontends (root or an attached child) prewarm at build time.
			provisioner.prewarm();
			// ensure() joins the in-flight prewarm rather than starting a second kernel.
			await provisioner.ensure();
			expect(countStarts()).toBe(1);
			expect(provisioner.hasRunningKernel).toBe(true);
		} finally {
			await provisioner.dispose({ snapshot: false });
		}
	});
});
