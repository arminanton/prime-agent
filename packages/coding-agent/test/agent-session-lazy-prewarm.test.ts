import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { manifestPathIn, snapshotPathIn } from "../src/core/kernel/state-snapshot.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createDefaultRuntimeFactory } from "../src/main.js";

// Lazy kernel prewarm (A.5). A daemon-hydrated passive session (e.g. a woken subagent
// child) must not eagerly start a Python kernel and restore its pickle at build time; it
// defers to the first actual ipython use. Interactive/main agents still prewarm. The gate
// decision is exercised directly on a partial session instance.

interface PrewarmHandle {
	_prewarmIpythonKernel: boolean;
	_rlmDepth: number;
	_shouldEagerPrewarmKernel(hasSnapshot: boolean): boolean;
}

function makeSession(prewarm: boolean, rlmDepth = 0): PrewarmHandle {
	return Object.assign(Object.create(AgentSession.prototype) as object, {
		_prewarmIpythonKernel: prewarm,
		_rlmDepth: rlmDepth,
	}) as unknown as PrewarmHandle;
}

const ENV = "PRIME_AGENT_EAGER_KERNEL_PREWARM_ON_HYDRATE";

describe("lazy kernel prewarm (A.5)", () => {
	afterEach(() => {
		delete process.env[ENV];
	});

	it("an interactive/root agent (depth 0) prewarms regardless of snapshot or env", () => {
		const session = makeSession(true, 0);
		expect(session._shouldEagerPrewarmKernel(false)).toBe(true);
		expect(session._shouldEagerPrewarmKernel(true)).toBe(true);
	});

	it("a depth>0 child never prewarms from the request even when prewarmIpythonKernel is true", () => {
		// The Deploy A regression: the production factory forces prewarmIpythonKernel:true for every
		// session, so this depth gate is the only thing keeping a depth>0 child from eager-starting.
		const child = makeSession(true, 1);
		expect(child._shouldEagerPrewarmKernel(false)).toBe(false);
		expect(child._shouldEagerPrewarmKernel(true)).toBe(false);
	});

	it("a passive snapshot-bearing session defers by default (no eager kernel start)", () => {
		const session = makeSession(false, 0);
		expect(session._shouldEagerPrewarmKernel(true)).toBe(false);
		expect(session._shouldEagerPrewarmKernel(false)).toBe(false);
	});

	it("the env switch restores eager on-hydrate prewarm for a snapshot-bearing session", () => {
		const session = makeSession(false, 0);
		process.env[ENV] = "1";
		expect(session._shouldEagerPrewarmKernel(true)).toBe(true);
		// There is still nothing to prewarm without a snapshot.
		expect(session._shouldEagerPrewarmKernel(false)).toBe(false);
	});

	it("the on-hydrate env switch is independent of depth (an explicit operator opt-in)", () => {
		const child = makeSession(false, 2);
		process.env[ENV] = "1";
		expect(child._shouldEagerPrewarmKernel(true)).toBe(true);
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


// A real production-factory test (createDefaultRuntimeFactory is THE factory every daemon/runtime
// -hosted session is created through). It sets prewarmIpythonKernel:true UNCONDITIONALLY and
// overwrites a false passed via sessionOptions, so the ONLY thing that keeps a depth>0 child from
// eager-starting is AgentSession's depth gate. The direct-provisioner tests above cannot catch a
// regression here because they never build a session through the factory. The kernel-spawn boundary
// (IpythonKernelProvisioner.prototype.prewarm) is the single stubbed point, so nothing real starts.
describe("lazy kernel prewarm factory integration (A.5)", () => {
	let tempDir = "";
	let restorePrewarm: (() => void) | undefined;
	let prewarmCalls = 0;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-a5-factory-"));
		prewarmCalls = 0;
		const original = IpythonKernelProvisioner.prototype.prewarm;
		IpythonKernelProvisioner.prototype.prewarm = function patchedPrewarm() {
			prewarmCalls++;
		};
		restorePrewarm = () => {
			IpythonKernelProvisioner.prototype.prewarm = original;
		};
	});

	afterEach(() => {
		restorePrewarm?.();
		restorePrewarm = undefined;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function buildFactory(faux: ReturnType<typeof registerFauxProvider>) {
		return createDefaultRuntimeFactory(
			{
				agentDir: tempDir,
				cwd: tempDir,
				sessionDir: join(tempDir, "sessions"),
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				telemetryDisabled: true,
			},
			[
				(pi) =>
					pi.registerProvider(faux.getModel().provider, {
						baseUrl: faux.getModel().baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((m) => ({
							id: m.id,
							name: m.name,
							api: m.api,
							reasoning: m.reasoning,
							input: m.input,
							cost: m.cost,
							contextWindow: m.contextWindow,
							maxTokens: m.maxTokens,
						})),
					}),
			],
		);
	}

	async function createThroughFactory(rlmDepth: number, requestedPrewarm: boolean | undefined) {
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		const factory = buildFactory(faux);
		const sessionDir = join(tempDir, `session-depth${rlmDepth}-${String(requestedPrewarm)}`);
		const sessionManager = SessionManager.create(tempDir, sessionDir);
		sessionManager.newSession({ rlmDepth });
		const created = await factory({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
			sessionOptions: {
				model: faux.getModel(),
				thinkingLevel: "off",
				rlmDepth,
				rlmMaxDepth: 2,
				rlmSessionDir: sessionDir,
				// A depth>0 child may be created with prewarm unset OR explicitly false; the factory
				// overwrites both with true, so the depth gate must still defer.
				...(requestedPrewarm === undefined ? {} : { prewarmIpythonKernel: requestedPrewarm }),
			},
		});
		return { faux, created };
	}

	it("a depth>0 factory session starts NO kernel at creation, even with prewarm unset or false", async () => {
		for (const requested of [undefined, false] as const) {
			const { faux, created } = await createThroughFactory(1, requested);
			try {
				expect(created.session.rlmDepth).toBe(1);
				expect(created.session.getActiveToolNames()).toContain("ipython");
				// The regression signal: this was 1 before the depth gate was restored.
				expect(prewarmCalls).toBe(0);
			} finally {
				await created.session.disposeAsync();
				faux.unregister();
				prewarmCalls = 0;
			}
		}
	});

	it("a root (depth 0) factory session prewarms exactly once", async () => {
		const { faux, created } = await createThroughFactory(0, undefined);
		try {
			expect(created.session.rlmDepth).toBe(0);
			expect(created.session.getActiveToolNames()).toContain("ipython");
			expect(prewarmCalls).toBe(1);
		} finally {
			await created.session.disposeAsync();
			faux.unregister();
		}
	});
});
