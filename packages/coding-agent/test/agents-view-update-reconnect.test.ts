import { describe, expect, it, vi } from "vitest";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import { DaemonSocketClosedError, type DaemonClientCloseListener } from "../src/modes/daemon/daemon-client.js";

describe("Agents View coordinator closing notices", () => {
	it.each(["update", "shutdown"] as const)("routes a %s notice without changing raw-client replay policy", async (reason) => {
		let onClose!: DaemonClientCloseListener;
		const client = {
			onClose: (listener: DaemonClientCloseListener) => { onClose = listener; return () => {}; },
			reconnect: vi.fn(async () => {}),
		};
		const restoredRows = [{ id: "restored-row" }];
		const view = Object.assign(Object.create(AgentsViewMode.prototype) as object, {
			client,
			stopped: false,
			daemonShutdownReceived: false,
			reconnectTimedOut: false,
			reconnectPromise: undefined as Promise<void> | undefined,
			options: { recoverDaemon: vi.fn(async () => {}), reconnectTimeoutMs: 1000 },
			rosterStore: { attach: vi.fn(async () => true), summaries: () => restoredRows },
			refreshHeartbeats: vi.fn(async () => true),
			setStatusMessage: vi.fn(),
			applySessionList: vi.fn(),
			armSavedSearchFetch: vi.fn(),
		});
		const subscribe = Reflect.get(AgentsViewMode.prototype, "subscribeToClientClose") as (this: object, client: object) => void;
		subscribe.call(view, client);
		onClose(new DaemonSocketClosedError("/memory/agents-view", reason));
		await view.reconnectPromise;
		if (reason === "update") {
			expect(client.reconnect).toHaveBeenCalledOnce();
			expect(view.daemonShutdownReceived).toBe(false);
			expect(view.applySessionList).toHaveBeenCalledWith(restoredRows, true);
			expect(view.setStatusMessage).toHaveBeenLastCalledWith("Daemon reconnected", { render: false });
		} else {
			expect(client.reconnect).not.toHaveBeenCalled();
			expect(view.daemonShutdownReceived).toBe(true);
			expect(view.setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("daemon shut down"), { tone: "error", sticky: true });
		}
	});
});
