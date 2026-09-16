import type * as ChildProcessTypes from "../src/utils/child-process.js";
import type * as SessionLeaseTypes from "../src/core/session-lease.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/utils/child-process.js", async (original) => ({ ...await original<typeof ChildProcessTypes>(), isProcessAlive: () => true }));
vi.mock("../src/core/session-lease.js", async (original) => ({ ...await original<typeof SessionLeaseTypes>(), getProcessStartId: () => "start" }));
import { captureCommittedEpochWorkers, escalateCommittedEpochWorkers } from "../src/cli/daemon-update-retirement.js";
import { defaultWorkerDescriptorDir } from "../src/modes/daemon/daemon-worker-descriptors.js";
import type { DaemonUpdateRestartManifest } from "../src/modes/daemon/daemon-protocol.js";
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("committed descriptor epoch retirement", () => {
	it("signals only this manifest's captured members and holds a survivor without terminal archive", async () => {
		vi.useFakeTimers(); const root = mkdtempSync(join(tmpdir(), "epoch-workers-")); roots.push(root);
		const socketPath = join(root, "daemon.sock"); const directory = defaultWorkerDescriptorDir(root, socketPath); mkdirSync(directory, { recursive: true });
		const descriptor = (workerId: string, rootActiveSessionId: string, pid: number) => ({ version: 2, workerId, rootActiveSessionId, pid, processStartId: "start",
			supervisorSocketPath: socketPath, socketPath: join(root, workerId + ".sock"), authenticationToken: "secret-not-for-status", recoveryJournalPath: join(root, workerId + ".jsonl"),
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lifecycle: "recovering", consecutiveFailures: 0, createCommand: { type: "create" } });
		const member = descriptor("member", "included", 123); const outsider = descriptor("outsider", "old-root", 456);
		writeFileSync(join(directory, "member.json"), JSON.stringify(member)); writeFileSync(join(directory, "outsider.json"), JSON.stringify(outsider));
		const manifest: DaemonUpdateRestartManifest = { formatVersion: 1, createdAt: new Date().toISOString(), sessions: [], discardedActiveSessionIds: ["included"] };
		const workers = captureCommittedEpochWorkers(root, socketPath, manifest); expect(workers).toHaveLength(1);
		// The old predecessor upgrades survivors after our PREPARE inventory. Only this exact epoch may rescind that upgrade.
		writeFileSync(join(directory, "member.json"), JSON.stringify({ ...member, stopRequestedAt: new Date().toISOString(), archiveOnStop: true }));
		const signal = vi.fn(); const progress = vi.fn();
		const work = escalateCommittedEpochWorkers({ agentDir: root, socketPath, manifest, workers, allowSignals: true, assertAdmission: async () => {}, onProgress: progress,
			operations: { isAlive: () => true, startId: () => "start", signal } });
		await vi.advanceTimersByTimeAsync(5000);
		expect([...(await work)]).toEqual(["included"]); expect(signal.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
		const saved = JSON.parse(readFileSync(join(directory, "member.json"), "utf8"));
		expect(saved).toHaveProperty("updateRestartRecoveryHold.rootActiveSessionId", "included");
		expect(saved).not.toHaveProperty("stopRequestedAt"); expect(saved).not.toHaveProperty("archiveOnStop");
		expect(JSON.parse(readFileSync(join(directory, "outsider.json"), "utf8"))).toEqual(outsider);
		expect(JSON.stringify(progress.mock.calls)).not.toContain("secret-not-for-status");
	});
});
