import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";

class CatalogChild extends EventEmitter {
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	send = vi.fn((_message: unknown, callback: (error?: Error) => void) => { callback(); return true; });
	disconnect = vi.fn(() => { this.connected = false; });
	kill = vi.fn((_signal: NodeJS.Signals) => true);
	exit(code = 0): void { this.exitCode = code; this.emit("exit", code, null); }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bounded catalog stop", () => {
	it("does not go through request/start and contains a child that never exits", async () => {
		vi.useFakeTimers();
		const catalog = new DaemonCatalogClient(vi.fn());
		const child = new CatalogChild();
		Object.assign(catalog, { child });
		const start = vi.spyOn(catalog, "start").mockResolvedValue();
		let stopped = false;
		void catalog.stop().then(() => { stopped = true; });
		await vi.advanceTimersByTimeAsync(2000);
		expect(start).not.toHaveBeenCalled();
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(stopped).toBe(true);
	});

	it("exits on disconnect without a kill and stops only once", async () => {
		vi.useFakeTimers();
		const catalog = new DaemonCatalogClient(vi.fn());
		const child = new CatalogChild();
		child.disconnect.mockImplementation(() => { child.connected = false; child.exit(); });
		Object.assign(catalog, { child });
		const stopping = catalog.stop();
		expect(catalog.stop()).toBe(stopping);
		await stopping;
		expect(child.kill).not.toHaveBeenCalled();
		expect(child.send).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never starts an absent catalog and rejects later requests", async () => {
		const catalog = new DaemonCatalogClient(vi.fn());
		await catalog.stop();
		await expect(catalog.start()).rejects.toThrow("stopping");
		await expect(catalog.list()).rejects.toThrow("stopping");
	});

	it("bounds both an in-flight startup and a blocked send within the same two seconds", async () => {
		vi.useFakeTimers();
		const catalog = new DaemonCatalogClient(vi.fn());
		const child = new CatalogChild();
		child.send.mockImplementation(() => true);
		Object.assign(catalog, { child, starting: new Promise(() => {}) });
		const stopping = catalog.stop();
		await vi.advanceTimersByTimeAsync(2000);
		await stopping;
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(child.listenerCount("exit")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never clears a newer child and keeps an unkillable captured child as evidence", async () => {
		vi.useFakeTimers();
		const diagnostic = vi.fn();
		const catalog = new DaemonCatalogClient(diagnostic);
		const oldChild = new CatalogChild();
		const newChild = new CatalogChild();
		Object.assign(catalog, { child: oldChild });
		const stopping = catalog.stop();
		Object.assign(catalog, { child: newChild });
		await vi.advanceTimersByTimeAsync(2000);
		await stopping;
		expect((catalog as unknown as { child: CatalogChild }).child).toBe(newChild);
		expect(newChild.kill).not.toHaveBeenCalled();
		expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("survived SIGKILL"));
	});

	it("rejects in-flight requests when stopping instead of leaving their five minute timers", async () => {
		vi.useFakeTimers();
		const catalog = new DaemonCatalogClient(vi.fn());
		const child = new CatalogChild();
		Object.assign(catalog, { child });
		const list = catalog.list();
		const rejected = expect(list).rejects.toThrow("stopping");
		await vi.advanceTimersByTimeAsync(0);
		const stopping = catalog.stop();
		await rejected;
		await vi.advanceTimersByTimeAsync(2000);
		await stopping;
		expect(vi.getTimerCount()).toBe(0);
	});
});
