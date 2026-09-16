import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonWorkerClient, DaemonWorkerProbeTimeoutError } from "../src/modes/daemon/daemon-worker-client.js";

function pendingSend() {
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
	return { promise, reject };
}

function makeClient(send: () => Promise<void>) {
	const client = new DaemonWorkerClient("in-memory-worker");
	const socket = { destroyed: false, destroy: vi.fn() };
	Object.assign(client, { socket, channel: { send: vi.fn(send), close: vi.fn() } });
	return client;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("worker request write deadline", () => {
	it("returns the response deadline even when the write callback never fires", async () => {
		vi.useFakeTimers();
		const client = makeClient(() => new Promise(() => {}));
		let error: unknown;
		void client.request({ type: "shutdown" }, 50).catch((reason) => { error = reason; });
		await vi.advanceTimersByTimeAsync(50);
		expect(error).toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects a send failure and clears its response timer", async () => {
		vi.useFakeTimers();
		const failure = new Error("write failed");
		const client = makeClient(() => Promise.reject(failure));
		await expect(client.request({ type: "shutdown" }, 50)).rejects.toBe(failure);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("observes a late write rejection without settling the request again", async () => {
		vi.useFakeTimers();
		const send = pendingSend();
		const client = makeClient(() => send.promise);
		const rejected = vi.fn();
		const result = client.request({ type: "shutdown" }, 50).catch(rejected);
		await vi.advanceTimersByTimeAsync(50);
		await result;
		send.reject(new Error("late write failure"));
		await vi.advanceTimersByTimeAsync(0);
		expect(rejected).toHaveBeenCalledTimes(1);
		expect(rejected.mock.calls[0][0]).toBeInstanceOf(DaemonWorkerProbeTimeoutError);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts a response before its write callback", async () => {
		vi.useFakeTimers();
		const send = pendingSend();
		const client = makeClient(() => send.promise);
		const result = client.request({ type: "shutdown" }, 50);
		const response: DaemonResponse = { type: "response", command: "shutdown", success: true, id: "worker_1" };
		(client as unknown as { handleFrame(frame: unknown): void }).handleFrame({
			header: { kind: "outbound", outboundType: "response", requestId: "worker_1" },
			payload: Buffer.from(JSON.stringify(response)),
		});
		await expect(result).resolves.toEqual(response);
		send.reject(new Error("late write failure"));
		await vi.advanceTimersByTimeAsync(50);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("close rejects a pending request even when its write is blocked", async () => {
		vi.useFakeTimers();
		const send = pendingSend();
		const client = makeClient(() => send.promise);
		const result = client.request({ type: "shutdown" }, 50);
		client.close();
		await expect(result).rejects.toThrow("Daemon worker client closed");
		send.reject(new Error("write destroyed"));
		await vi.advanceTimersByTimeAsync(50);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps disconnected and synchronous write failures as promise rejections", async () => {
		await expect(new DaemonWorkerClient("in-memory").request({ type: "shutdown" })).rejects.toThrow("not connected");
		const failure = new Error("synchronous write failure");
		const client = makeClient(() => { throw failure; });
		await expect(client.request({ type: "shutdown" }, 50)).rejects.toBe(failure);
	});
});
