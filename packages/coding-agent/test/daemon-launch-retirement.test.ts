import type * as ChildProcessTypes from "../src/utils/child-process.js";
import type * as SessionLeaseTypes from "../src/core/session-lease.js";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ alive: true, startId: "start", connectable: false }));
vi.mock("../src/utils/child-process.js", async (original) => ({ ...await original<typeof ChildProcessTypes>(),
	isProcessAlive: vi.fn(() => state.alive) }));
vi.mock("../src/core/session-lease.js", async (original) => ({ ...await original<typeof SessionLeaseTypes>(),
	getProcessStartId: vi.fn(() => state.startId) }));
vi.mock("../src/modes/daemon/daemon-client.js", () => ({ DaemonClient: class {
	async connect() { if (!state.connectable) throw new Error("unreachable"); }
	close() {}
} }));
import { canConnectToDaemon, hasProcessIdentityExited, requestDaemonShutdownAndWait } from "../src/cli/daemon-launch.js";
import type { DaemonClient, DaemonHello } from "../src/modes/daemon/daemon-client.js";

afterEach(() => { vi.useRealTimers(); Object.assign(state, { alive: true, startId: "start", connectable: false }); });

describe("daemon retirement facts", () => {
	it("treats a dead/zombie identity or a reused pid as exited, but not an exact live pid", () => {
		expect(hasProcessIdentityExited({ pid: 123, processStartId: "start" })).toBe(false);
		state.alive = false;
		expect(hasProcessIdentityExited({ pid: 123, processStartId: "start" })).toBe(true);
		state.alive = true; state.startId = "new-start";
		expect(hasProcessIdentityExited({ pid: 123, processStartId: "start" })).toBe(true);
	});
	it("reports shutdown acceptance separately from confirmed process exit", async () => {
		vi.useFakeTimers();
		const client = { request: vi.fn(async () => ({ success: true })), close: vi.fn() } as unknown as DaemonClient;
		const result = requestDaemonShutdownAndWait(client, "/memory/daemon.sock", 100,
			{ supervisorPid: 123, supervisorProcessStartId: "start" } as DaemonHello);
		await vi.advanceTimersByTimeAsync(100);
		expect(await result).toEqual({ stopped: false, shutdownAccepted: true });
		expect(client.close).toHaveBeenCalledTimes(1);
		expect(await canConnectToDaemon("/memory/daemon.sock", 250)).toBe(false);
	});
});
