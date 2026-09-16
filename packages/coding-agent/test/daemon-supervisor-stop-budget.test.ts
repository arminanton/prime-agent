import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface StopBudgetSupervisor {
	finalizeArchivedWorkerStop(worker: unknown): Promise<void>;
	cancelEphemeralWorkerScheduledJobs(worker: unknown): Promise<boolean>;
}

const worker = () => ({
	descriptor: { workerId: "worker", pid: 42, rootSessionId: "root", ownerClientId: "client" }, stopRevision: 1,
});

function supervisor(fields: object): StopBudgetSupervisor {
	return Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
		shuttingDown: true,
		workerSessionArtifactContext: () => ({ artifactDir: "in-memory", sessionFile: "in-memory/session.jsonl" }),
		log: vi.fn(),
	}, fields) as StopBudgetSupervisor;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("worker stop cleanup bounds", () => {
	it("bounds archive failure so the caller retains its tombstone", async () => {
		vi.useFakeTimers();
		vi.spyOn(AgentCronJobStore, "forSessionArtifacts").mockReturnValue({
			registerSessionArtifact: vi.fn(), cancelJobsForSession: vi.fn(),
		} as unknown as AgentCronJobStore);
		const sup = supervisor({ catalog: { archive: () => new Promise(() => {}) } });
		const stopped = sup.finalizeArchivedWorkerStop(worker());
		const failed = expect(stopped).rejects.toThrow("catalog archive exceeded its 5000 ms");
		await vi.advanceTimersByTimeAsync(5000);
		await failed;
	});

	it("retains failed cancellation intent and fences a late family read", async () => {
		vi.useFakeTimers();
		let stillWanted!: () => boolean;
		const sup = supervisor({
			cancelScheduledJobsForSessionTree: (_id: string, _file: string, guard: () => boolean) => {
				stillWanted = guard;
				return new Promise(() => {});
			},
		});
		const stopped = sup.cancelEphemeralWorkerScheduledJobs(worker());
		expect(stillWanted()).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await stopped).toBe(false);
		expect(stillWanted()).toBe(false);
	});
});
