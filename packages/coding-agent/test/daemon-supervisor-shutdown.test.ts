import { EventEmitter } from "node:events";
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
		workers: new Map([["worker", {
			descriptor: { workerId: "worker" }, transcriptCaches: new Map(), snapshotCache: new Map(), snapshotLoads: new Map(),
		}]]),
		openingWorkers: new Map(),
		catalogOpeningWorkers: new Map(),
		cleanupSocket: vi.fn(),
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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("supervisor shutdown failures", () => {
	it("bounds the server close callback when a peer never completes FIN", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		let closeCallback: (() => void) | undefined;
		const socket = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn(), destroy: vi.fn() });
		socket.destroy.mockImplementation(() => { socket.destroyed = true; closeCallback?.(); });
		const client = { socket, detachInput: vi.fn(), attachedActiveSessionIds: new Set() };
		Object.assign(supervisor, {
			clients: new Set([client]),
			server: { close: (done: () => void) => { closeCallback = done; } },
		});
		void supervisor.shutdown(0, true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(socket.end).toHaveBeenCalledTimes(1);
		expect(socket.destroy).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
	});

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
	it("joins a repeat without skipping cleanup and permits an explicit force exit", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		Object.assign(supervisor, { cleanupSupervisorResources: () => new Promise(() => {}) });
		const first = supervisor.shutdown(0, false);
		expect(supervisor.shutdown(0, false)).toBe(first);
		expect(exit).not.toHaveBeenCalled();
		supervisor.shutdown(143, false, false, true);
		expect(exit).toHaveBeenCalledWith(143);
	});

	it("arms an unref hard exit before any await and never extends it on reentry", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		Object.assign(supervisor, { cleanupSupervisorResources: () => new Promise(() => {}) });
		const first = supervisor.shutdown(0, false);
		const timer = (supervisor as unknown as { shutdownHardExitTimer: NodeJS.Timeout }).shutdownHardExitTimer;
		expect(timer.hasRef()).toBe(false);
		await vi.advanceTimersByTimeAsync(44_999);
		expect(supervisor.shutdown(0, false)).toBe(first);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it.each([undefined, "prepared"])("preserves both descriptor and schedules when phase is %s", async (phase) => {
		vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		Object.assign(supervisor, { updateRestartPhase: phase });
		await supervisor.shutdown(0, true);
		const terminal = phase !== "prepared";
		expect(supervisor.stopWorker).toHaveBeenCalledWith(expect.anything(), terminal, false, terminal);
	});

	it("still force-exits on a signal received while an ordinary shutdown is joining", () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		const handlers = new Map<string, (...args: unknown[]) => void>();
		vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
			handlers.set(event, handler);
			return process;
		}) as typeof process.on);
		(supervisor as unknown as { registerSignalHandlers(): void }).registerSignalHandlers();
		Object.assign(supervisor, { shuttingDown: true });
		handlers.get("SIGTERM")?.(); // Invoke the captured function, never send a real signal.
		expect(exit).toHaveBeenCalledWith(143);
	});

	it("shares close ownership with exceptional cleanup and reports the bounded stages", async () => {
		vi.useFakeTimers();
		vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		const close = vi.fn((done: () => void) => done());
		Object.assign(supervisor, { server: { close } });
		const shutdown = supervisor.shutdown(0, true);
		const cleanup = (supervisor as unknown as { cleanupSupervisorResources(): Promise<void> }).cleanupSupervisorResources();
		await Promise.all([shutdown, cleanup]);
		expect(close).toHaveBeenCalledTimes(1);
		for (const stage of ["idle eviction sweep", "worker stop", "catalog stop", "server close"]) {
			expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining(`shutdown stage ${stage}: ok`));
		}
	});

	it("logs a server close timeout and still exits when the callback never fires", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const supervisor = makeSupervisor();
		Object.assign(supervisor, { server: { close: vi.fn() } });
		const shutdown = supervisor.shutdown(0, true);
		await vi.advanceTimersByTimeAsync(2000);
		await shutdown;
		expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("shutdown stage server close: TIMED OUT"));
		expect(exit).toHaveBeenCalledWith(0);
	});

});
