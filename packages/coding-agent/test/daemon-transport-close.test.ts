import { EventEmitter } from "node:events";
import type { Server, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { closeDaemonTransport } from "../src/modes/daemon/daemon-transport-close.js";

// In Node the close call removes the listening handle before its callback can
// run. The old code awaited that callback forever when one accepted peer held
// FIN open. Model that contract in memory, never stop a real process for a test.
function closeContract(count: number, neverCallback = false) {
	let remaining = count;
	let callback: (() => void) | undefined;
	const server = {
		listening: true,
		close: vi.fn((done: () => void) => {
			server.listening = false;
			callback = done;
			if (remaining === 0 && !neverCallback) done();
		}),
	};
	const clients = Array.from({ length: count }, () => {
		const socket = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn(), destroy: vi.fn() });
		socket.destroy.mockImplementation(() => {
			if (socket.destroyed) return;
			socket.destroyed = true;
			remaining--;
			socket.emit("close");
			if (remaining === 0 && !neverCallback) callback?.();
		});
		const controller = new AbortController();
		const client = {
			socket: socket as unknown as Socket,
			detachInput: vi.fn(),
			snapshotTransferAbortControllers: new Map([["session", controller]]),
		} as unknown as DaemonSocketClient;
		return { client, socket, controller };
	});
	return { server, clients, callback: () => callback?.() };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("daemon transport close contract", () => {
	it.each([1, 50])("uses one grace period for %i stopped peers", async (count) => {
		vi.useFakeTimers();
		const fixture = closeContract(count);
		const result = closeDaemonTransport(fixture.server as unknown as Server, fixture.clients.map((v) => v.client), vi.fn());
		expect(fixture.server.listening).toBe(false);
		for (const { socket, controller } of fixture.clients) {
			expect(socket.end).toHaveBeenCalledTimes(1);
			expect(controller.signal.aborted).toBe(true);
		}
		await vi.advanceTimersByTimeAsync(999);
		expect(fixture.clients.every(({ socket }) => !socket.destroyed)).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(await result).toMatchObject({ ok: true });
		expect(fixture.clients.every(({ socket }) => socket.destroyed)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("abandons a callback that never runs and ignores a late callback", async () => {
		vi.useFakeTimers();
		const fixture = closeContract(1, true);
		const result = closeDaemonTransport(fixture.server as unknown as Server, fixture.clients.map((v) => v.client), vi.fn());
		await vi.advanceTimersByTimeAsync(2000);
		expect(await result).toMatchObject({ ok: false, timedOut: true });
		fixture.callback();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("contains thrown close/end calls and destroys the accepted socket anyway", async () => {
		vi.useFakeTimers();
		const fixture = closeContract(1);
		fixture.server.close.mockImplementation(() => { throw new Error("close failed"); });
		fixture.clients[0].socket.end.mockImplementation(() => { throw new Error("end failed"); });
		const failure = vi.fn();
		const result = await closeDaemonTransport(fixture.server as unknown as Server, fixture.clients.map((v) => v.client), failure);
		expect(result).toMatchObject({ ok: false, timedOut: false });
		expect(fixture.clients[0].socket.destroyed).toBe(true);
		expect(failure).toHaveBeenCalledWith("daemon client end", expect.any(Error));
		expect(vi.getTimerCount()).toBe(0);
	});
});
