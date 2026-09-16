import type * as ChildProcessTypes from "../src/utils/child-process.js";
import type * as SessionLeaseTypes from "../src/core/session-lease.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ alive: true, lock: vi.fn(async () => vi.fn(async () => {})) }));
vi.mock("proper-lockfile", () => ({ default: { lock: state.lock } }));
vi.mock("../src/utils/child-process.js", async (original) => ({ ...await original<typeof ChildProcessTypes>(),
	isProcessAlive: vi.fn(() => state.alive) }));
vi.mock("../src/core/session-lease.js", async (original) => ({ ...await original<typeof SessionLeaseTypes>(),
	getProcessStartId: vi.fn(() => "start") }));
import { acquireDaemonShutdownAdmission, DaemonShutdownAdmissionError, DaemonStartupFenceTimeoutError, waitForDaemonStartupFence } from "../src/modes/daemon/daemon-supervisor-ownership.js";
const roots: string[] = [];
const registryEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const originalRegistry = process.env[registryEnv];
function registry() {
	const root = mkdtempSync(join(tmpdir(), "retirement-owner-")); roots.push(root);
	process.env[registryEnv] = root; return root;
}
afterEach(() => {
	vi.useRealTimers(); state.alive = true; state.lock.mockReset().mockImplementation(async () => vi.fn(async () => {}));
	if (originalRegistry === undefined) delete process.env[registryEnv]; else process.env[registryEnv] = originalRegistry;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded retirement authority", () => {
	it("returns the exact fence identity on timeout and never clears a live fence", async () => {
		vi.useFakeTimers(); const root = registry(); const socketPath = join(root, "daemon.sock");
		const directory = join(root, "startup-fences"); mkdirSync(directory);
		const path = join(directory, createHash("sha256").update(socketPath).digest("hex") + ".json");
		const fence = { version: 1, token: "fence", ownerToken: "owner", pid: 123, processStartId: "start",
			socketPath, supervisorGeneration: "generation", createdAt: new Date().toISOString() };
		writeFileSync(path, JSON.stringify(fence));
		const wait = waitForDaemonStartupFence(socketPath, 250, root);
		const failed = expect(wait).rejects.toMatchObject({ name: "DaemonStartupFenceTimeoutError", fence,
			message: "Timed out waiting for predecessor daemon process 123 to exit" });
		await vi.advanceTimersByTimeAsync(250); await failed;
		expect(existsSync(path)).toBe(true); expect(DaemonStartupFenceTimeoutError.prototype).toBeInstanceOf(Error);
		state.alive = false; await waitForDaemonStartupFence(socketPath, 250, root); expect(existsSync(path)).toBe(false);
	});
	it("never displaces a live admission holder at its deadline", async () => {
		vi.useFakeTimers(); const root = registry(); const path = join(root, "shutdown-admission.json");
		const record = { version: 1, token: "foreign", pid: 123, processStartId: "start", createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5000).toISOString() };
		writeFileSync(path, JSON.stringify(record));
		const acquisition = acquireDaemonShutdownAdmission(200);
		const failed = expect(acquisition).rejects.toBeInstanceOf(DaemonShutdownAdmissionError);
		await vi.advanceTimersByTimeAsync(200); await failed;
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(record);
	});
	it("releases a late guard acquisition without writing admission", async () => {
		vi.useFakeTimers(); const root = registry(); const release = vi.fn(async () => {});
		let acquire!: (value: typeof release) => void;
		state.lock.mockReturnValueOnce(new Promise((resolve) => { acquire = resolve; }));
		const acquisition = acquireDaemonShutdownAdmission(200);
		const failed = expect(acquisition).rejects.toThrow("registry guard acquisition");
		await vi.advanceTimersByTimeAsync(200); await failed;
		acquire(release); await vi.advanceTimersByTimeAsync(0);
		expect(release).toHaveBeenCalledTimes(1); expect(existsSync(join(root, "shutdown-admission.json"))).toBe(false);
	});
});
