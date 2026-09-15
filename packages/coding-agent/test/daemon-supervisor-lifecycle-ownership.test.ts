import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

// Lifecycle-aware worker ownership (F10). These exercise the split between OWNERSHIP of a
// session path, WAKE-ELIGIBILITY (coverage), and RECLAIMABILITY of a confirmed-dead
// descriptor, without starting a real daemon or worker process. A partial supervisor is
// built on the prototype and the process-identity probe is stubbed per worker pid.

type Identity = "current" | "replaced" | "gone" | "unknown";

interface TestWorker {
	descriptor: {
		workerId: string;
		lifecycle: string;
		pid: number;
		processStartId?: string;
		sessionFile: string;
		createCommand: { sessionPath: string };
		ownerClientId?: string;
		stopRequestedAt?: string;
		recoveryJournalPath: string;
	};
	descriptorPath: string;
	client?: unknown;
	recovery?: Promise<void>;
	intentionalStop: boolean;
}

interface SupervisorHandle {
	workers: Map<string, TestWorker>;
	workerStopCounts: Map<TestWorker, number>;
	processIdentity: (pid: number, startId?: string) => Identity;
	flipWorkerRosterEntriesInactive: ReturnType<typeof vi.fn>;
	deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
	validateAndPersistUpdateManifest: ReturnType<typeof vi.fn>;
	coversScheduledWake(worker: TestWorker): boolean;
	findWorkerBySessionFile(sessionFile: string): TestWorker | undefined;
	findWakeableWorkerBySessionFile(sessionFile: string): TestWorker | undefined;
	isReclaimableDeadDescriptor(worker: TestWorker): boolean;
	reclaimStaleDeadWorkers(): TestWorker[];
	prepareUpdateRestartFenced(deadline: number): Promise<{ sessions: unknown[] }>;
}

function makeSupervisor(processIdentity: (pid: number, startId?: string) => Identity = () => "current"): SupervisorHandle {
	return Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
		workers: new Map<string, TestWorker>(),
		workerStopCounts: new Map<TestWorker, number>(),
		shuttingDown: true,
		processIdentity,
		log: () => {},
		roster: () => ({ bySessionFile: () => undefined }),
		flipWorkerRosterEntriesInactive: vi.fn(),
		deleteWorkerDescriptor: vi.fn(),
		validateAndPersistUpdateManifest: vi.fn(),
	}) as unknown as SupervisorHandle;
}

function makeWorker(opts: {
	workerId?: string;
	lifecycle?: string;
	pid?: number;
	processStartId?: string;
	sessionFile?: string;
	ownerClientId?: string;
	stopRequestedAt?: string;
	client?: unknown;
	recovery?: Promise<void>;
	intentionalStop?: boolean;
}): TestWorker {
	const sessionFile = opts.sessionFile ?? "/tmp/prime-agent-f10-test/root.jsonl";
	return {
		descriptor: {
			workerId: opts.workerId ?? "w1",
			lifecycle: opts.lifecycle ?? "ready",
			pid: opts.pid ?? 4321,
			processStartId: opts.processStartId,
			sessionFile,
			createCommand: { sessionPath: sessionFile },
			ownerClientId: opts.ownerClientId,
			stopRequestedAt: opts.stopRequestedAt,
			recoveryJournalPath: "/tmp/prime-agent-f10-test/journal",
		},
		descriptorPath: "/tmp/prime-agent-f10-test/descriptor.json",
		client: opts.client,
		recovery: opts.recovery,
		intentionalStop: opts.intentionalStop ?? false,
	};
}

describe("daemon supervisor lifecycle-aware ownership (F10)", () => {
	it("coversScheduledWake counts only a runnable owner", () => {
		const sup = makeSupervisor((pid) => (pid === 1 ? "gone" : "current"));
		expect(sup.coversScheduledWake(makeWorker({ lifecycle: "ready", pid: 2 }))).toBe(true);
		expect(sup.coversScheduledWake(makeWorker({ lifecycle: "recovering", pid: 2 }))).toBe(true);
		// A failed owner does not run the schedule.
		expect(sup.coversScheduledWake(makeWorker({ lifecycle: "failed", pid: 1 }))).toBe(false);
		// A "ready" descriptor whose process is gone is a crash not yet marked failed.
		expect(sup.coversScheduledWake(makeWorker({ lifecycle: "ready", pid: 1 }))).toBe(false);
		// A stopping owner is going away.
		expect(
			sup.coversScheduledWake(makeWorker({ lifecycle: "ready", pid: 2, stopRequestedAt: new Date().toISOString() })),
		).toBe(false);
		// starting/recovering workers are mid-launch and keep coverage even without a live pid yet.
		expect(sup.coversScheduledWake(makeWorker({ lifecycle: "starting", pid: 1 }))).toBe(true);
	});

	it("a failed descriptor with a dead pid no longer masks its root from the wake scan", () => {
		const sessionFile = "/tmp/prime-agent-f10-test/root-a.jsonl";
		const sup = makeSupervisor(() => "gone");
		const failed = makeWorker({ workerId: "wf", lifecycle: "failed", pid: 1, sessionFile });
		sup.workers.set(failed.descriptor.workerId, failed);
		// Ownership still resolves (unchanged), but wake-eligibility does not.
		expect(sup.findWorkerBySessionFile(sessionFile)).toBe(failed);
		expect(sup.findWakeableWorkerBySessionFile(sessionFile)).toBeUndefined();

		const live = makeSupervisor(() => "current");
		const ready = makeWorker({ workerId: "wr", lifecycle: "ready", pid: 2, sessionFile });
		live.workers.set(ready.descriptor.workerId, ready);
		expect(live.findWakeableWorkerBySessionFile(sessionFile)).toBe(ready);
	});

	it("isReclaimableDeadDescriptor removes only confirmed-dead, unowned descriptors", () => {
		expect(
			makeSupervisor(() => "gone").isReclaimableDeadDescriptor(makeWorker({ lifecycle: "failed", pid: 1 })),
		).toBe(true);
		// live-but-unreachable (identity current, disconnected) is NOT reclaimed.
		expect(
			makeSupervisor(() => "current").isReclaimableDeadDescriptor(makeWorker({ lifecycle: "failed", pid: 2 })),
		).toBe(false);
		// unverifiable identity is fail-closed.
		expect(
			makeSupervisor(() => "unknown").isReclaimableDeadDescriptor(makeWorker({ lifecycle: "failed", pid: 3 })),
		).toBe(false);
		// client-owned sessions are not reclaimed here (they await their owner).
		expect(
			makeSupervisor(() => "gone").isReclaimableDeadDescriptor(
				makeWorker({ lifecycle: "failed", pid: 1, ownerClientId: "c1" }),
			),
		).toBe(false);
		// still connected -> not dead.
		expect(
			makeSupervisor(() => "gone").isReclaimableDeadDescriptor(makeWorker({ lifecycle: "failed", pid: 1, client: {} })),
		).toBe(false);
		// mid-recovery -> left alone.
		expect(
			makeSupervisor(() => "gone").isReclaimableDeadDescriptor(
				makeWorker({ lifecycle: "failed", pid: 1, recovery: Promise.resolve() }),
			),
		).toBe(false);
	});

	it("reclaimStaleDeadWorkers removes dead descriptors and keeps live-but-unreachable ones", () => {
		const sup = makeSupervisor((pid) => (pid === 1 ? "gone" : "current"));
		const dead = makeWorker({ workerId: "dead", lifecycle: "failed", pid: 1 });
		const live = makeWorker({ workerId: "live", lifecycle: "failed", pid: 2 });
		sup.workers.set(dead.descriptor.workerId, dead);
		sup.workers.set(live.descriptor.workerId, live);

		const removed = sup.reclaimStaleDeadWorkers();

		expect(removed).toEqual([dead]);
		expect(sup.workers.has("dead")).toBe(false);
		expect(sup.workers.has("live")).toBe(true);
		expect(sup.flipWorkerRosterEntriesInactive).toHaveBeenCalledWith(dead);
		expect(sup.deleteWorkerDescriptor).toHaveBeenCalledWith(dead);
		expect(sup.deleteWorkerDescriptor).not.toHaveBeenCalledWith(live);
	});

	it("prepareUpdateRestartFenced reclaims dead descriptors instead of failing on them", async () => {
		const sup = makeSupervisor(() => "gone");
		sup.workers.set("d1", makeWorker({ workerId: "d1", lifecycle: "failed", pid: 1 }));
		sup.workers.set("d2", makeWorker({ workerId: "d2", lifecycle: "failed", pid: 1 }));

		const manifest = await sup.prepareUpdateRestartFenced(Date.now() + 60_000);

		expect(sup.workers.size).toBe(0);
		expect(manifest.sessions).toEqual([]);
		expect(sup.validateAndPersistUpdateManifest).toHaveBeenCalledTimes(1);
	});
});
