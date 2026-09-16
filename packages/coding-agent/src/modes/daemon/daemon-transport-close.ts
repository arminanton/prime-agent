import type { Server } from "node:net";
import { type SettleResult, settleWithinBudget } from "../../utils/settle-within-budget.js";
import { abortClientSnapshotStreaming, type DaemonSocketClient } from "./active-session-state.js";

export const DAEMON_CLIENT_END_GRACE_MS = 1_000;
export const DAEMON_SERVER_CLOSE_BUDGET_MS = 2_000;

/**
 * Closing the listener can unlink its path before the close callback runs.
 * A peer that never sends FIN must not own the daemon's exit deadline.
 * Only our accepted socket ends are destroyed. Client processes are not signaled.
 */
export async function closeDaemonTransport(
	server: Pick<Server, "close"> | undefined,
	clients: readonly DaemonSocketClient[],
	reportFailure: (label: string, error: unknown) => void,
): Promise<SettleResult<void>> {
	let resolveClosed!: () => void;
	let rejectClosed!: (error: unknown) => void;
	const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
	const settled = settleWithinBudget("server close", DAEMON_SERVER_CLOSE_BUDGET_MS, closed);
	const destroyAll = () => {
		for (const client of clients) {
			try { if (!client.socket.destroyed) client.socket.destroy(); }
			catch (error) { reportFailure("daemon client destroy", error); }
		}
	};
	const grace = setTimeout(destroyAll, DAEMON_CLIENT_END_GRACE_MS);
	grace.unref?.();
	try {
		try {
			if (server) server.close((error?: Error) => error ? rejectClosed(error) : resolveClosed());
			else resolveClosed();
		} catch (error) { rejectClosed(error); }
		for (const client of clients) {
			try {
				abortClientSnapshotStreaming(client);
				clearTimeout(client.catchupRetryTimer);
				client.catchupRetryTimer = undefined;
				client.catchupActiveSessionIds?.clear();
				client.catchupPurposes?.clear();
				client.detachInput();
			} catch (error) { reportFailure("daemon client input", error); }
			try { client.socket.end(); }
			catch (error) { reportFailure("daemon client end", error); }
		}
		return await settled;
	} finally {
		clearTimeout(grace);
		destroyAll();
	}
}
