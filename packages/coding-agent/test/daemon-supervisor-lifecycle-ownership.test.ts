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
	recoverUncertainWorkerOperations: ReturnType<typeof vi.fn>;
	invalidateWorkerSessionInputPauses: ReturnType<typeof vi.fn>;
	validateAndPersistUpdateManifest: ReturnType<typeof vi.fn>;
	coversScheduledWake(worker: TestWorker): boolean;
	findWorkerBySessionFile(sessionFile: string): TestWorker | undefined;
	findWakeableWorkerBySessionFile(sessionFile: string): TestWorker | undefined;
	isReclaimableDeadDescriptor(worker: TestWorker): boolean;
	reclaimStaleDeadWorkers(): Promise<TestWorker[]>;
	prepareUpdateRestartFenced(deadline: number): Promise<{ sessions: unknown[] }>;
	// Lifecycle gates read by the reclaim broadcast (M3) and settable per test.
	startupComplete: boolean;
	shuttingDown: boolean;
	updateRestartPhase?: "draining" | "fencing" | "prepared";
	broadcastHeartbeatsChanged: () => void;
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
		recoverUncertainWorkerOperations: vi.fn(async () => {}),
		invalidateWorkerSessionInputPauses: vi.fn(),
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
		// A failed owner whose process is CONFIRMED dead does not run the schedule.
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

	it("a failed-but-ALIVE owner stays covered (no head-of-line-blocking recovery ladder)", () => {
		// R8: a blanket failed -> uncovered would turn a failed-but-alive current worker into a
		// scheduler-driven recovery ladder, and wakeDueScheduledSessions is sequential, so one
		// wedged live worker would block every other due heartbeat. Fail closed: keep it covered.
		const current = makeSupervisor(() => "current");
		expect(current.coversScheduledWake(makeWorker({ lifecycle: "failed", pid: 2, processStartId: "s" }))).toBe(true);
		// An unverifiable ("unknown") failed worker is also fail-closed (still alive).
		const unknown = makeSupervisor(() => "unknown");
		expect(unknown.coversScheduledWake(makeWorker({ lifecycle: "failed", pid: 2 }))).toBe(true);
		// A failed worker whose pid was REPLACED (recycled) is confirmed dead -> uncovered.
		const replaced = makeSupervisor(() => "replaced");
		expect(replaced.coversScheduledWake(makeWorker({ lifecycle: "failed", pid: 2, processStartId: "s" }))).toBe(false);
	});

	it("ready+replaced is symmetric with ready+gone (both un-cover the root)", () => {
		const replaced = makeSupervisor(() => "replaced");
		expect(replaced.coversScheduledWake(makeWorker({ lifecycle: "ready", pid: 2, processStartId: "s" }))).toBe(false);
		const gone = makeSupervisor(() => "gone");
		expect(gone.coversScheduledWake(makeWorker({ lifecycle: "ready", pid: 1 }))).toBe(false);
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

	it("reclaimStaleDeadWorkers removes dead descriptors and keeps live-but-unreachable ones", async () => {
		const sup = makeSupervisor((pid) => (pid === 1 ? "gone" : "current"));
		const dead = makeWorker({ workerId: "dead", lifecycle: "failed", pid: 1 });
		const live = makeWorker({ workerId: "live", lifecycle: "failed", pid: 2 });
		sup.workers.set(dead.descriptor.workerId, dead);
		sup.workers.set(live.descriptor.workerId, live);

		const removed = await sup.reclaimStaleDeadWorkers();

		expect(removed).toEqual([dead]);
		expect(sup.workers.has("dead")).toBe(false);
		expect(sup.workers.has("live")).toBe(true);
		expect(sup.flipWorkerRosterEntriesInactive).toHaveBeenCalledWith(dead);
		expect(sup.deleteWorkerDescriptor).toHaveBeenCalledWith(dead);
		expect(sup.deleteWorkerDescriptor).not.toHaveBeenCalledWith(live);
	});

	it("reclaimStaleDeadWorkers runs the settling path (orphan reaping) before deleting a descriptor", async () => {
		// R7: reuse the identity-verified reclaim, not a bare descriptor delete, so a worker that
		// died after being parked failed still reaps its orphan kernels and invalidates input
		// pauses BEFORE its descriptor + journal are removed.
		const sup = makeSupervisor(() => "gone");
		const dead = makeWorker({ workerId: "dead", lifecycle: "failed", pid: 1 });
		sup.workers.set(dead.descriptor.workerId, dead);

		await sup.reclaimStaleDeadWorkers();

		expect(sup.recoverUncertainWorkerOperations).toHaveBeenCalledWith(dead);
		expect(sup.invalidateWorkerSessionInputPauses).toHaveBeenCalled();
		expect(sup.deleteWorkerDescriptor).toHaveBeenCalledWith(dead);
		// Cleanup (orphan reaping) must run before the descriptor + journal are deleted.
		const reapOrder = sup.recoverUncertainWorkerOperations.mock.invocationCallOrder[0];
		const deleteOrder = sup.deleteWorkerDescriptor.mock.invocationCallOrder[0];
		expect(reapOrder).toBeLessThan(deleteOrder);
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

	it("a transient cleanup failure stays retryable and reclaims on a later sweep (A.3 M4)", async () => {
		// The trap: intentionalStop was set BEFORE the awaited cleanup and never rolled back, so a
		// transient recoverUncertainWorkerOperations rejection wedged the worker as "stopping" and
		// isReclaimableDeadDescriptor then excluded it forever (no retry after the fault cleared).
		const sup = makeSupervisor(() => "gone");
		const dead = makeWorker({ workerId: "dead", lifecycle: "failed", pid: 1, processStartId: "old" });
		sup.workers.set(dead.descriptor.workerId, dead);
		let attempts = 0;
		sup.recoverUncertainWorkerOperations = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("injected transient cleanup error");
		});

		// First sweep: cleanup rejects. The descriptor is retained AND stays retryable.
		await sup.reclaimStaleDeadWorkers();
		expect(attempts).toBe(1);
		expect(sup.workers.has("dead")).toBe(true);
		expect(dead.intentionalStop).toBe(false);
		expect(sup.isReclaimableDeadDescriptor(dead)).toBe(true);
		expect(sup.deleteWorkerDescriptor).not.toHaveBeenCalled();

		// A later sweep once the fault clears reclaims the worker.
		await sup.reclaimStaleDeadWorkers();
		expect(attempts).toBe(2);
		expect(sup.workers.has("dead")).toBe(false);
		expect(sup.deleteWorkerDescriptor).toHaveBeenCalledWith(dead);
	});

	it("reclaim broadcasts a wake only when fully ready, never during boot or update-restart (A.3 M3)", async () => {
		const broadcastCount = async (state: {
			startupComplete: boolean;
			shuttingDown: boolean;
			updateRestartPhase?: "draining" | "fencing" | "prepared";
		}): Promise<number> => {
			const sup = makeSupervisor(() => "gone");
			sup.workers.set("dead", makeWorker({ workerId: "dead", lifecycle: "failed", pid: 1 }));
			Object.assign(sup, state);
			const broadcast = vi.fn();
			sup.broadcastHeartbeatsChanged = broadcast;
			await sup.reclaimStaleDeadWorkers();
			return broadcast.mock.calls.length;
		};

		// Boot: the reclaim runs before markReady/startupComplete, so it must not arm an early wake.
		expect(await broadcastCount({ startupComplete: false, shuttingDown: false })).toBe(0);
		// Preparing an update restart: no wake armed.
		expect(await broadcastCount({ startupComplete: true, shuttingDown: false, updateRestartPhase: "draining" })).toBe(0);
		// Shutting down: no wake.
		expect(await broadcastCount({ startupComplete: true, shuttingDown: true })).toBe(0);
		// Fully ready normal operation: the reclaim broadcasts so a freed root can be woken.
		expect(await broadcastCount({ startupComplete: true, shuttingDown: false })).toBe(1);
	});

	it("a sole root: ready+covered -> disconnect+failed -> reclaimed so a due wake can fire (A.3)", async () => {
		// End-to-end at the supervisor-method level (no real worker process): a lone root that owns
		// its scheduled job covers its own wake while ready; once its client disconnects and its
		// process dies (parked failed), the dead descriptor stops masking the root from the wake
		// scan, is reclaimed, and the now-ready daemon arms a wake recompute for the due job.
		let identity: Identity = "current";
		const sup = makeSupervisor(() => identity);
		Object.assign(sup, { startupComplete: true, shuttingDown: false });
		const broadcast = vi.fn();
		sup.broadcastHeartbeatsChanged = broadcast;
		const sessionFile = "/tmp/prime-agent-f10-test/sole-root.jsonl";
		const root = makeWorker({
			workerId: "root",
			lifecycle: "ready",
			pid: 7,
			processStartId: "s",
			sessionFile,
			client: {},
		});
		sup.workers.set(root.descriptor.workerId, root);

		// Ready + connected: the root covers its own scheduled wake and is not reclaimable.
		expect(sup.findWakeableWorkerBySessionFile(sessionFile)).toBe(root);
		expect(sup.isReclaimableDeadDescriptor(root)).toBe(false);

		// The client disconnects and the process dies; the monitor parks the descriptor failed.
		root.client = undefined;
		root.descriptor.ownerClientId = undefined;
		root.descriptor.lifecycle = "failed";
		identity = "gone";

		// The failed dead descriptor no longer masks the root from the wake scan and is reclaimable.
		expect(sup.findWakeableWorkerBySessionFile(sessionFile)).toBeUndefined();
		expect(sup.isReclaimableDeadDescriptor(root)).toBe(true);

		// Reclaim removes it and, now that the daemon is fully ready, arms a wake recompute so the
		// sole root's due scheduled job can fire.
		const removed = await sup.reclaimStaleDeadWorkers();
		expect(removed).toEqual([root]);
		expect(sup.workers.has("root")).toBe(false);
		expect(broadcast).toHaveBeenCalledTimes(1);
	});
});
