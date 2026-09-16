import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorHandle {
	shutdown(exitCode: number, stopWorkers: boolean, relaunch?: boolean, forceWorkers?: boolean): Promise<never>;
	installCrashHandlers(): void;
	signalCleanupHandlers: Array<() => void>;
	log: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	catalog: { stop: ReturnType<typeof vi.fn> };
}

function makeSupervisor(): SupervisorHandle {
	return Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
		shuttingDown: false,
		workers: new Map([["worker", { descriptor: { workerId: "worker" } }]]),
		clients: new Set(),
		signalCleanupHandlers: [],
		clearIdleEvictionTimer: vi.fn(),
		clearScheduledWakeTimer: vi.fn(),
		clearRosterWatchdogTimer: vi.fn(),
		stopWorker: vi.fn(async () => { throw new Error("injected non-timeout stop failure"); }),
		hasPersistedWorkerDescriptors: () => true,
		catalog: { stop: vi.fn(async () => {}) },
		server: { close: (done: () => void) => done() },
		runCleanupStep: vi.fn(async () => {}),
		log: vi.fn(),
	}) as SupervisorHandle;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("supervisor shutdown failures", () => {
	it("retains a tombstone and reaches exit after a non-timeout worker stop failure", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		await supervisor.shutdown(0, true);
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("tombstone retained"));
		expect(supervisor.catalog.stop).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("fatal process handlers preserve resident workers", () => {
		const supervisor = makeSupervisor();
		const shutdown = vi.spyOn(supervisor, "shutdown").mockReturnValue(new Promise(() => {}));
		const handlers = new Map<string, (...args: unknown[]) => void>();
		vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, handler);
			return process;
		}) as typeof process.on);
		supervisor.installCrashHandlers();
		handlers.get("unhandledRejection")?.(new Error("unhandled test rejection"));
		handlers.get("uncaughtException")?.(new Error("uncaught test exception"));
		expect(shutdown.mock.calls).toEqual([[1, false], [1, false]]);
		expect(supervisor.log).toHaveBeenCalledTimes(2);
	});
});
