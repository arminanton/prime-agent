import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { DAEMON_UPDATE_RESTART_FORMAT_VERSION, type DaemonUpdateRestartManifest } from "../src/modes/daemon/daemon-protocol.js";
import { type DaemonWorkerDescriptor, durableDaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import { type DaemonWorkerRecoveryHold, readDaemonWorkerRecoveryHold, withDaemonWorkerRecoveryHold } from "../src/modes/daemon/daemon-worker-recovery-hold.js";

function descriptor(): DaemonWorkerDescriptor {
	return { version: 2, workerId: "worker", pid: 123, processStartId: "start", rootActiveSessionId: "root",
		socketPath: "/memory/worker.sock", supervisorSocketPath: "/memory/daemon.sock", recoveryJournalPath: "/memory/recovery.jsonl",
		authenticationToken: "local", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
		lifecycle: "ready", createCommand: { type: "create", sessionPath: "/memory/session.jsonl" }, consecutiveFailures: 0 };
}
function hold(): DaemonWorkerRecoveryHold {
	return { reason: "update_restart_recovery_uncertain", pid: 123, processStartId: "start", rootActiveSessionId: "root",
		activeSessionIds: ["root"], manifestCreatedAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString() };
}

describe("local worker recovery holds", () => {
	it("roundtrips only through the descriptor-file annotation, never the wire projection", () => {
		const persisted = withDaemonWorkerRecoveryHold(descriptor(), hold());
		expect(readDaemonWorkerRecoveryHold(persisted)).toEqual(hold());
		expect(durableDaemonWorkerDescriptor(persisted)).not.toHaveProperty("updateRestartRecoveryHold");
		expect(() => readDaemonWorkerRecoveryHold({ ...persisted, pid: 999 })).toThrow("does not match");
		const diagnostic = vi.fn();
		expect(withDaemonWorkerRecoveryHold({ ...descriptor(), pid: 999 }, hold(), diagnostic)).not.toHaveProperty("updateRestartRecoveryHold");
		expect(diagnostic).toHaveBeenCalledTimes(1);
	});

	it("publishes PREPARE and retains evidence when an exact worker survives force stop", async () => {
		const manifest: DaemonUpdateRestartManifest = { formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
			createdAt: new Date(0).toISOString(), sessions: [], discardedActiveSessionIds: ["root"] };
		const client = { requestWorker: vi.fn(async () => ({ success: true, data: manifest })) };
		const participant = { descriptor: descriptor(), client };
		const persist = vi.fn();
		const validate = vi.fn();
		const sup = Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			workers: new Map([["worker", participant]]), reclaimStaleDeadWorkers: vi.fn(async () => []),
			isWorkerStopping: () => false, validateAndPersistUpdateManifest: validate,
			stopWorker: vi.fn(async () => { throw new Error("worker survived SIGKILL"); }),
			processIdentity: () => "current", persistWorker: persist, log: vi.fn(),
		}) as { prepareUpdateRestartFenced(deadline: number): Promise<DaemonUpdateRestartManifest> };
		const result = await sup.prepareUpdateRestartFenced(Date.now() + 100_000);
		expect(result.discardedActiveSessionIds).toEqual(["root"]);
		expect(validate).toHaveBeenCalledTimes(1);
		expect(participant).toMatchObject({ intentionalStop: true, descriptor: { lifecycle: "recovering" },
			updateRestartRecoveryHold: { pid: 123, processStartId: "start", activeSessionIds: ["root"] } });
		expect(persist).toHaveBeenCalledWith(participant);
	});

	it("does not re-adopt or retry a held live worker, and releases the hold only after identity retirement", async () => {
		let identity = "current";
		const participant = { descriptor: descriptor(), updateRestartRecoveryHold: hold(), intentionalStop: false };
		const connect = vi.fn();
		const sup = Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			processIdentity: () => identity, persistWorker: vi.fn(), assertRecoveryAllowed: vi.fn(async () => {}), connectWorker: connect,
		}) as { adoptOrRecoverWorker(worker: unknown): Promise<void>; retryWorkerRecovery(worker: unknown): Promise<void>;
			isUpdateRestartRecoveryHeld(worker: unknown): boolean };
		await sup.adoptOrRecoverWorker(participant);
		expect(connect).not.toHaveBeenCalled();
		await expect(sup.retryWorkerRecovery(participant)).rejects.toThrow("recovery-uncertain");
		expect(participant.intentionalStop).toBe(true);
		identity = "gone";
		expect(sup.isUpdateRestartRecoveryHeld(participant)).toBe(false);
		expect(participant.intentionalStop).toBe(false);
		expect(participant.descriptor.lifecycle).toBe("failed");
	});
});
