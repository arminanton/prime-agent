import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("final kernel snapshot visibility", () => {
	it("names the session when a busy kernel skips its final snapshot", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const manager = new ReplKernelManager({ cwd: "/memory", sessionId: "session-test", snapshot: { path: "/memory/state", manifestPath: "/memory/manifest" } });
		Object.assign(manager, { state: "running", executionQueue: new Promise(() => {}) });
		const flush = (manager as unknown as { runSnapshotFlushForDispose(): Promise<void> }).runSnapshotFlushForDispose();
		await vi.advanceTimersByTimeAsync(5000);
		await flush;
		expect(warn).toHaveBeenCalledWith("session session-test: final kernel snapshot skipped: kernel did not settle");
	});
});
