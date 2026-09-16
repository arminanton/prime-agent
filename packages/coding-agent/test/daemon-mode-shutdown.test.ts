import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

interface WorkerHandle {
	shutdown(code: number): Promise<never>;
	log: ReturnType<typeof vi.fn>;
	closeSession: ReturnType<typeof vi.fn>;
	cleanupSocketPath: ReturnType<typeof vi.fn>;
}

function worker(): WorkerHandle {
	return Object.assign(Object.create(AgentDaemon.prototype) as object, {
		shuttingDown: false, clients: new Set(), sessions: new Map([["session", { activeSessionId: "session" }]]),
		peerGrants: new Map(), signalCleanupHandlers: [],
		stopWorkerMemoryGuard: vi.fn(), log: vi.fn(),
		summarizer: { stop: vi.fn() }, cronScheduler: { stop: vi.fn() },
		closeSession: vi.fn(() => new Promise(() => {})),
		recordWorkerRecoveryState: vi.fn(),
		cleanupSocketPath: vi.fn(),
		server: { close: (done: () => void) => done() },
	}) as WorkerHandle;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded worker shutdown", () => {
	it("bounds a stuck session disposal without releasing it at the timeout", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const daemon = worker();
		void daemon.shutdown(0);
		await vi.advanceTimersByTimeAsync(35_000);
		expect(exit).toHaveBeenCalledWith(0);
		expect(daemon.log).toHaveBeenCalledWith(expect.stringContaining("recovery-uncertain"));
	});

	it("shares shutdown and shortens its hard backstop after session close", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const daemon = worker();
		daemon.closeSession.mockResolvedValue(undefined);
		Object.assign(daemon, { closeTransportBounded: () => new Promise(() => {}) });
		const first = daemon.shutdown(0);
		expect(daemon.shutdown(0)).toBe(first);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("keeps the hard exit below 45 seconds even if the session stage itself is broken", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const daemon = worker();
		Object.assign(daemon, { closeSessionsForRetirement: () => new Promise(() => {}) });
		void daemon.shutdown(1);
		const timer = (daemon as unknown as { shutdownHardExitTimer: NodeJS.Timeout }).shutdownHardExitTimer;
		expect(timer.hasRef()).toBe(false);
		await vi.advanceTimersByTimeAsync(45_000);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("bounds a close callback that never runs after a successful session close", async () => {
		vi.useFakeTimers();
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const daemon = worker();
		daemon.closeSession.mockResolvedValue(undefined);
		Object.assign(daemon, { server: { close: vi.fn() } });
		const shutdown = daemon.shutdown(0);
		await vi.advanceTimersByTimeAsync(2000);
		await shutdown;
		expect(exit).toHaveBeenCalledWith(0);
		expect(daemon.log).toHaveBeenCalledWith(expect.stringContaining("server close: TIMED OUT"));
	});
});
