import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionState } from "../src/modes/agent-connection/types.js";
import {
	DaemonSocketClosedError,
	type DaemonClientCloseListener,
	type DaemonClientMessageListener,
	type DaemonClientRequestOptions,
	type DaemonCommandBody,
	type DaemonHello,
	type DaemonTransportClient,
} from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO, type DaemonOutbound, type DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonRoutedClient } from "../src/modes/daemon/daemon-routed-client.js";
import type { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

class ProbeTransport implements DaemonTransportClient {
	isConnected = true;
	availableAt = 0;
	hello: DaemonHello | undefined = {
		type: "daemon_hello", socketPath: "/memory/probe", protocol: DAEMON_PROTOCOL_INFO,
		clientId: "probe", supervisorGeneration: "original", serverCapabilities: [],
	};
	private readonly messages = new Set<DaemonClientMessageListener>();
	private readonly closes = new Set<DaemonClientCloseListener>();
	readonly resetTransportForReconnect = vi.fn(() => { this.isConnected = false; });
	readonly connect = vi.fn(async () => {
		if (Date.now() < this.availableAt) throw new Error("supervisor unavailable");
		this.isConnected = true;
		this.hello = { type: "daemon_hello", socketPath: "/memory/probe", protocol: DAEMON_PROTOCOL_INFO,
			clientId: "probe", supervisorGeneration: "replacement", serverCapabilities: [] };
	});
	reconnect = this.connect;
	supportsServerCapability(): boolean { return false; }
	async waitForHello(): Promise<DaemonHello> { return this.hello!; }
	enableRequestRecovery(): void {}
	onMessage(listener: DaemonClientMessageListener): () => void { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
	onClose(listener: DaemonClientCloseListener): () => void { this.closes.add(listener); return () => { this.closes.delete(listener); }; }
	emit(message: DaemonOutbound): void { for (const listener of [...this.messages]) listener(message); }
	disconnectForReconnect(reason?: "update" | "shutdown"): void {
		this.isConnected = false;
		for (const listener of [...this.closes]) listener(new DaemonSocketClosedError("/memory/probe", reason));
	}
	close(): void { this.isConnected = false; }
	readonly request = vi.fn(async (command: DaemonCommandBody, _timeout?: number, options?: DaemonClientRequestOptions): Promise<DaemonResponse> => {
		const response: DaemonResponse = {
			type: "response", command: command.type, success: true,
			data: command.type === "attach" ? { id: command.activeSessionId, activeSessionId: command.activeSessionId,
				sessionId: "session", sessionFile: "/memory/session.jsonl", cwd: "/memory", lifecycle: "live", activity: "working",
				isSessionActive: true, isStreaming: true, isCompacting: false, attachedClients: 1, messageCount: 1,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] } } : { sessions: [] },
		};
		options?.onResponse?.(response);
		return response;
	});
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("generic reconnect revision ownership", () => {
	it("keeps recovering the supervisor when the held direct session is replaced", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const supervisor = new ProbeTransport();
		const direct = new ProbeTransport();
		const routed = new DaemonRoutedClient(supervisor, direct as unknown as DaemonWorkerClient);
		const connection = await DaemonAgentConnection.attach(routed, "active", { recoverDaemon: async () => {} });
		const statuses: string[] = [];
		connection.subscribe((event) => { if (event.type === "connection_status") statuses.push(event.status); });
		try {
			supervisor.availableAt = 5000;
			supervisor.disconnectForReconnect();
			await vi.advanceTimersByTimeAsync(1000);
			direct.emit({ type: "session_replaced", activeSessionId: "active", messages: [],
				state: { sessionId: "new-session", sessionFile: "/memory/new-session.jsonl" } as AgentConnectionState });
			await vi.advanceTimersByTimeAsync(30_000);
			expect(statuses).toEqual(["reconnecting", "connected"]);
			expect(supervisor.isConnected).toBe(true);
			expect(routed.hasDirectTransport).toBe(true);
		} finally {
			await connection.dispose();
			routed.close();
		}
	});

	it("does not reset a sibling's connected transport while its hello is pending", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const transport = new ProbeTransport();
		const connection = await DaemonAgentConnection.attach(transport, "active");
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => { events.push(event); });
		const normalRequest = transport.request.getMockImplementation()!;
		transport.request.mockImplementation(async (command, timeout, options) => {
			if (command.type === "list") {
				// The old request loses its socket after another adapter has connected,
				// but before that new connection's hello has arrived.
				transport.hello = undefined;
				transport.isConnected = true;
				throw new Error("old list request disconnected");
			}
			return normalRequest(command, timeout, options);
		});
		try {
			transport.emit({ type: "session_closed", activeSessionId: "active", reason: "update" });
			await vi.advanceTimersByTimeAsync(1);
			expect(transport.request.mock.calls.some(([command]) => command.type === "list")).toBe(true);
			expect(transport.resetTransportForReconnect).not.toHaveBeenCalled();
			expect(transport.isConnected).toBe(true);
			expect(events.some((event) => event.type === "closed")).toBe(false);
		} finally {
			await connection.dispose();
			transport.close();
		}
	});
});
