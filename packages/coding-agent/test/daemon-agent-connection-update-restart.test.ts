import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionState } from "../src/modes/agent-connection/types.js";
import { DaemonClient, DaemonSocketClosedError, type DaemonClientMessageListener, type DaemonClientCloseListener, type DaemonTransportClient } from "../src/modes/daemon/daemon-client.js";
import { DaemonRoutedClient } from "../src/modes/daemon/daemon-routed-client.js";
import type { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonCommandEnvelope,
	type DaemonOutbound,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function state(activeSessionId: string, isStreaming: boolean): AgentConnectionState {
	return {
		activeSessionId,
		cwd: "/test/project",
		model: undefined,
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: "/test/session.jsonl",
		sessionId: "durable-session",
		sessionName: "Restorable session",
		sessionDir: "/test",
		leafId: "leaf",
		autoCompactionEnabled: true,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
	};
}

function snapshot(activeSessionId: string, isStreaming: boolean): DaemonAttachResult {
	const current = state(activeSessionId, isStreaming);
	const messages = [{ role: "user" as const, content: "continue this task", timestamp: 1 }];
	const cursor = { generation: `generation-${activeSessionId}`, sequence: 1 };
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: {
				id: activeSessionId,
				activeSessionId,
				sessionId: current.sessionId,
				sessionFile: current.sessionFile,
				cwd: current.cwd,
				lifecycle: "live",
				activity: isStreaming ? "working" : "idle",
				isSessionActive: isStreaming,
				isStreaming,
				isCompacting: false,
				attachedClients: 1,
				messageCount: messages.length,
				sessionActions: current.sessionActions,
			},
			state: current,
			messages,
			sessionContext: { messages, thinkingLevel: current.thinkingLevel, serviceTier: current.serviceTier, model: null },
			lastEventSequence: cursor.sequence,
			lastEventCursor: cursor,
		},
		lastEventSequence: cursor.sequence,
		lastEventCursor: cursor,
		replay: { status: "complete", toSequence: cursor.sequence, toCursor: cursor },
		client: { id: "test-client", capabilities: ["attach_snapshot", "event_sequence", "slim_attach"] },
	};
}

/** One socket address, with deterministic predecessor and successor connection scripts. */
async function startCutoverScript(streaming: boolean, options: {
	generationKnown?: boolean;
	predecessorReason?: "shutdown" | "update";
	predecessorRow?: "stopping" | "failed";
	pendingAdmission?: boolean;
	successorFailedRow?: boolean;
} = {}) {
	const directory = mkdtempSync(join(tmpdir(), "prime-update-reconnect-"));
	const socketPath = join(directory, "daemon.sock");
	const sockets: Socket[] = [];
	const trace: string[] = [];
	const requests: Array<{ connection: number; command: DaemonCommand }> = [];
	let predecessorAccepted!: () => void;
	const predecessorConnected = new Promise<void>((resolve) => { predecessorAccepted = resolve; });
	let promptAccepted!: () => void;
	const pendingPrompt = new Promise<void>((resolve) => { promptAccepted = resolve; });
	let successorListedFailed = false;
	let promptExecutions = 0;
	const send = (socket: Socket, event: DaemonOutbound) => socket.write(serializeJsonLine(event));
	let server: Server;
	server = createServer((socket) => {
		const connection = sockets.length;
		sockets.push(socket);
		trace.push(`accept:${connection}`);
		socket.on("error", () => undefined);
		send(socket, {
			type: "daemon_hello",
			socketPath,
			protocol: DAEMON_PROTOCOL_INFO,
			schemaId: DAEMON_SCHEMA_ID,
			schemaRevision: DAEMON_SCHEMA_REVISION,
			clientId: `client-${connection}`,
			...(options.generationKnown ? { supervisorGeneration: connection < 2 ? "predecessor" : "successor" } : {}),
			serverCapabilities: ["session_input_admission", "prompt_admission_cancellation", "resident_worker_recovery_context"],
		});
		if (connection === 1) predecessorAccepted();
		attachJsonlLineReader(socket, (line) => {
			const wire = JSON.parse(line) as DaemonCommand | DaemonCommandEnvelope;
			const command = wire.type === "command" ? wire.command : wire;
			if (command.type === "ack_result") return;
			requests.push({ connection, command });
			trace.push(`request:${connection}:${command.type}`);
			const reply = (data?: unknown) => send(socket, {
				type: "response", id: command.id, command: command.type, success: true, data,
			});
			if (connection === 1 && command.type === "list") {
				// A held predecessor can still list the durable row. Recovery must not touch it.
				if (options.predecessorRow) {
					reply({ sessions: [{ ...snapshot("old-active", streaming).snapshot.summary, workerState: options.predecessorRow }] });
					return;
				}
				reply({ sessions: [] });
				trace.push("predecessor:shutdown");
				socket.end(serializeJsonLine({ type: "daemon_closing", reason: options.predecessorReason ?? "shutdown" }));
				return;
			}
			if (command.type === "list") {
				if (options.successorFailedRow && !successorListedFailed) {
					successorListedFailed = true;
					reply({ sessions: [{ ...snapshot("old-active", false).snapshot.summary, workerState: "failed" }] });
				} else {
					reply({ sessions: [snapshot("restored-active", streaming).snapshot.summary] });
				}
			} else if (command.type === "attach") {
				if (connection >= 2 && command.activeSessionId === "old-active") {
					send(socket, { type: "response", id: command.id, command: "attach", success: false, error: "Session worker is failed" });
				} else {
					reply(snapshot(command.activeSessionId, connection >= 2 && streaming));
				}
			} else if (command.type === "prompt") {
				if (options.pendingAdmission && connection !== 0) {
					// The checkpoint closed this active ID. A stable-envelope replay is not a new execution.
					send(socket, { type: "response", id: command.id, command: "prompt", success: false,
						error: "Unknown active session: old-active" });
					return;
				}
				promptExecutions++;
				if (options.pendingAdmission) promptAccepted();
				else reply();
				send(socket, { type: "session_event", activeSessionId: "old-active", event: { type: "agent_start" } });
				send(socket, {
					type: "session_event", activeSessionId: "old-active",
					event: { type: "message_start", message: fauxAssistantMessage("partial response") },
				});
			} else {
				reply();
			}
		});
	});
	cleanup.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		rmSync(directory, { recursive: true, force: true });
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => { server.off("error", reject); resolveListen(); });
	});
	return {
		socketPath, trace, requests, predecessorConnected, pendingPrompt,
		get promptExecutions() { return promptExecutions; },
		endPredecessor: () => sockets[1]!.end(serializeJsonLine({ type: "daemon_closing", reason: options.predecessorReason ?? "shutdown" })),
		beginDaemonUpdate: () => sockets[0]!.end(serializeJsonLine({ type: "daemon_closing", reason: "update" })),
		abortSnapshotAndBeginUpdate: (failureFirst: boolean) => {
			const attached = snapshot("old-active", streaming);
			const { messages: _messages, ...slim } = attached.snapshot;
			const begin: DaemonOutbound = { type: "session_snapshot_begin", activeSessionId: "old-active", snapshotId: "cutover-snapshot", purpose: "resync", snapshot: slim, messageCount: 1, targetChunkBytes: 1024 };
			const failed: DaemonOutbound = { type: "session_snapshot_failed", activeSessionId: "old-active", snapshotId: "cutover-snapshot", error: "Snapshot aborted for update" };
			const closed: DaemonOutbound = { type: "session_closed", activeSessionId: "old-active", reason: "update" };
			sockets[0]!.write([begin, ...(failureFirst ? [failed, closed] : [closed, failed])].map(serializeJsonLine).join(""));
		},
		beginUpdate: () => {
			trace.push("worker:update");
			send(sockets[0]!, { type: "session_closed", activeSessionId: "old-active", reason: "update" });
		},
	};
}

function createDirectTransport() {
	let connected = true;
	const messages = new Set<DaemonClientMessageListener>();
	const closes = new Set<DaemonClientCloseListener>();
	const pending = new Set<(error: Error) => void>();
	const hello = { type: "daemon_hello" as const, socketPath: "/memory/direct", protocol: DAEMON_PROTOCOL_INFO, clientId: "direct", serverCapabilities: [] };
	const close = vi.fn(() => {
		connected = false;
		for (const reject of pending) reject(new Error("Daemon worker client closed"));
		pending.clear();
	});
	const transport: DaemonTransportClient = {
		hello,
		get isConnected() { return connected; },
		supportsServerCapability: () => true,
		waitForHello: async () => hello,
		connect: async () => {},
		reconnect: async () => {},
		disconnectForReconnect: close,
		resetTransportForReconnect: close,
		enableRequestRecovery: () => {},
		onMessage: (listener) => { messages.add(listener); return () => { messages.delete(listener); }; },
		onClose: (listener) => { closes.add(listener); return () => { closes.delete(listener); }; },
		request: async (command, _timeout, options) => {
			if (command.type === "attach") {
				const response: DaemonResponse = { type: "response", command: "attach", success: true, data: snapshot(command.activeSessionId, true) };
				options?.onResponse?.(response);
				return response;
			}
			return new Promise<DaemonResponse>((_resolve, reject) => pending.add(reject));
		},
		close,
	};
	return { transport: transport as unknown as DaemonWorkerClient, close };
}

function controlledTransport() {
	let connected = true;
	const listeners = new Set<DaemonClientMessageListener>();
	const closes = new Set<DaemonClientCloseListener>();
	const control = {
		availableAt: 0,
		restoredAt: 0,
		stalled: undefined as "attach" | "snapshot" | undefined,
		attachGate: undefined as Promise<void> | undefined,
	};
	const hello = { type: "daemon_hello" as const, socketPath: "/memory/update", protocol: DAEMON_PROTOCOL_INFO,
		clientId: "clocked", supervisorGeneration: "predecessor", serverCapabilities: [] };
	const emit = (message: DaemonOutbound) => { for (const listener of [...listeners]) listener(message); };
	const closeTransport = (reason?: "shutdown" | "update") => {
		connected = false;
		for (const listener of [...closes]) listener(new DaemonSocketClosedError(hello.socketPath, reason));
	};
	const reconnect = vi.fn(async () => {
		if (Date.now() < control.availableAt) throw new Error("successor unavailable");
		connected = true;
		hello.supervisorGeneration = "successor";
	});
	const request = vi.fn<DaemonTransportClient["request"]>(async (command, _timeout, options) => {
		let data: unknown;
		if (command.type === "attach") {
			if (command.activeSessionId === "restored-active" && control.stalled === "attach") {
				await (control.attachGate ?? new Promise<void>(() => {}));
			}
			const result = snapshot(command.activeSessionId, true);
			if (command.activeSessionId === "restored-active" && control.stalled === "snapshot") {
				result.snapshotStream = { id: "pending-snapshot", messageCount: 1, targetChunkBytes: 1024 };
			}
			data = result;
		} else if (command.type === "list") {
			data = { sessions: Date.now() >= control.restoredAt ? [snapshot("restored-active", true).snapshot.summary] : [] };
		}
		const response: DaemonResponse = { type: "response", command: command.type, success: true, data };
		options?.onResponse?.(response);
		return response;
	});
	const transport: DaemonTransportClient = {
		hello,
		get isConnected() { return connected; },
		supportsServerCapability: () => false,
		waitForHello: async () => hello,
		connect: reconnect,
		reconnect,
		disconnectForReconnect: (reason) => { if (connected) closeTransport(reason); },
		resetTransportForReconnect: () => { connected = false; },
		enableRequestRecovery: () => {},
		onMessage: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		onClose: (listener) => { closes.add(listener); return () => { closes.delete(listener); }; },
		request,
		close: () => { connected = false; },
	};
	return { transport, control, request, reconnect, closeTransport, emit };
}

describe("coordinator update reconnect ordering", () => {
	it.each([false, true])("survives the predecessor shutdown broadcast after update (streaming=%s)", async (streaming) => {
		const script = await startCutoverScript(streaming);
		const client = new DaemonClient(script.socketPath);
		cleanup.push(async () => client.close());
		await client.connect();
		await client.waitForHello();
		const connection = await DaemonAgentConnection.attach(client, "old-active", {
			recoverDaemon: async () => undefined,
		});
		cleanup.push(() => connection.dispose());
		const events: AgentConnectionEvent[] = [];
		let sawAgentStart!: () => void;
		const agentStarted = new Promise<void>((resolve) => { sawAgentStart = resolve; });
		const outcome = new Promise<AgentConnectionEvent>((resolve) => {
			connection.subscribe((event) => {
				events.push(event);
				if (event.type === "session_event" && event.event.type === "agent_start") sawAgentStart();
				if (event.type === "closed" || event.type === "session_resynced") resolve(event);
			});
		});
		if (streaming) {
			await connection.prompt("continue this task");
			await agentStarted;
		}
		script.beginUpdate();
		const result = await outcome;
		const losingOrder = ["worker:update", "accept:1", "request:1:list", "predecessor:shutdown"];
		expect(script.trace.filter((step) => losingOrder.includes(step))).toEqual(losingOrder);
		expect(result, JSON.stringify({ trace: script.trace, result })).toMatchObject({
			type: "session_resynced",
			snapshot: { state: { activeSessionId: "restored-active", sessionId: "durable-session", isStreaming: streaming } },
		});
		expect(events.some((event) => event.type === "closed")).toBe(false);
		expect(script.requests.filter(({ command }) => command.type === "attach").map(({ command }) => command))
			.toEqual([expect.objectContaining({ activeSessionId: "old-active" }), expect.objectContaining({ activeSessionId: "restored-active" })]);
		expect(script.requests.some(({ command }) => command.type === "abort" || command.type === "cancel_prompt_admission")).toBe(false);
	}, 10_000);

	it.each(["stopping", "failed"] as const)("waits for a new supervisor generation without touching a %s predecessor row", async (workerState) => {
		const script = await startCutoverScript(true, { generationKnown: true, predecessorRow: workerState });
		const client = new DaemonClient(script.socketPath);
		cleanup.push(async () => client.close());
		await client.connect();
		await client.waitForHello();
		const connection = await DaemonAgentConnection.attach(client, "old-active", {
			recoverDaemon: async () => undefined,
			residentSessionRecoveryConfig: { cwd: "/test/project" },
		});
		cleanup.push(() => connection.dispose());
		const recoveryRequests = vi.spyOn(client, "request");
		const predecessorHello = new Promise<void>((resolve) => client.onMessage((message) => {
			if (message.type === "daemon_hello" && message.supervisorGeneration === "predecessor") resolve();
		}));
		const events: AgentConnectionEvent[] = [];
		const restored = new Promise<void>((resolve) => connection.subscribe((event) => {
			events.push(event);
			if (event.type === "session_resynced" || event.type === "closed") resolve();
		}));
		script.beginUpdate();
		await script.predecessorConnected;
		await predecessorHello;
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(recoveryRequests.mock.calls.map(([command]) => command.type)).toEqual([]);
		expect(script.requests.filter(({ connection: index }) => index === 1).map(({ command }) => command.type)).toEqual([]);
		script.endPredecessor();
		await restored;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events.some((event) => event.type === "session_resynced")).toBe(true);
		expect(events.some((event) => event.type === "closed")).toBe(false);
	});

	it("does not race manifest restoration with retry_worker on a failed successor row", async () => {
		const script = await startCutoverScript(false, { successorFailedRow: true, predecessorReason: "update" });
		const client = new DaemonClient(script.socketPath);
		cleanup.push(async () => client.close());
		await client.connect();
		await client.waitForHello();
		const connection = await DaemonAgentConnection.attach(client, "old-active", {
			residentSessionRecoveryConfig: { cwd: "/client-config-not-manifest" },
		});
		cleanup.push(() => connection.dispose());
		const restored = new Promise<AgentConnectionEvent>((resolve) => connection.subscribe((event) => {
			if (event.type === "session_resynced" || event.type === "closed") resolve(event);
		}));
		script.beginUpdate();
		expect(await restored).toMatchObject({ type: "session_resynced", snapshot: { state: { activeSessionId: "restored-active" } } });
		expect(script.requests.some(({ command }) => command.type === "retry_worker")).toBe(false);
	});

	it("reports uncertain admission without cancellation when an interrupted prompt replays its old ID", async () => {
		const script = await startCutoverScript(true, { pendingAdmission: true });
		const client = new DaemonClient(script.socketPath);
		cleanup.push(async () => client.close());
		await client.connect();
		await client.waitForHello();
		const connection = await DaemonAgentConnection.attach(client, "old-active", { recoverDaemon: async () => undefined });
		cleanup.push(() => connection.dispose());
		const restored = new Promise<void>((resolve) => connection.subscribe((event) => {
			if (event.type === "session_resynced" || event.type === "closed") resolve();
		}));
		const result = connection.prompt("admit this once", { signal: new AbortController().signal }).catch((error: unknown) => error);
		await script.pendingPrompt;
		expect(script.requests.find(({ command }) => command.type === "prompt")?.command).toHaveProperty("admissionId");
		script.beginUpdate();
		await restored;
		expect(await result).toMatchObject({ name: "AgentConnectionPromptAdmissionError", status: "unknown" });
		const promptRequests = script.requests.filter(({ command }) => command.type === "prompt");
		expect(promptRequests).toHaveLength(2);
		expect(promptRequests[1]?.command).toEqual(promptRequests[0]?.command);
		expect(script.promptExecutions).toBe(1);
		expect(script.requests.some(({ command }) => command.type === "cancel_prompt_admission")).toBe(false);
	});

	it.each([false, true])("a routed client's snapshot abort in the update read cannot terminate recovery (failureFirst=%s)", async (failureFirst) => {
		const script = await startCutoverScript(true, { predecessorReason: "update" });
		const supervisor = new DaemonClient(script.socketPath);
		cleanup.push(async () => supervisor.close());
		await supervisor.connect();
		await supervisor.waitForHello();
		const direct = createDirectTransport();
		const routed = new DaemonRoutedClient(supervisor, direct.transport);
		const connection = await DaemonAgentConnection.attach(routed, "old-active", { recoverDaemon: async () => undefined });
		cleanup.push(() => connection.dispose());
		const events: AgentConnectionEvent[] = [];
		const restored = new Promise<AgentConnectionEvent>((resolve) => connection.subscribe((event) => {
			events.push(event);
			if (event.type === "session_resynced" || event.type === "closed") resolve(event);
		}));
		script.abortSnapshotAndBeginUpdate(failureFirst);
		expect(await restored).toMatchObject({ type: "session_resynced", snapshot: { state: { activeSessionId: "restored-active", isStreaming: true } } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events.some((event) => event.type === "closed")).toBe(false);
		expect(direct.close).toHaveBeenCalledOnce();
		expect(routed.hasDirectTransport).toBe(false);
	});


	it("coalesces a routed TUI and its supervisor watcher without dropping the new socket twice", async () => {
		const script = await startCutoverScript(true, { predecessorReason: "update" });
		const supervisor = new DaemonClient(script.socketPath);
		cleanup.push(async () => supervisor.close());
		await supervisor.connect();
		await supervisor.waitForHello();
		const direct = createDirectTransport();
		const routed = new DaemonRoutedClient(supervisor, direct.transport);
		const tui = await DaemonAgentConnection.attach(routed, "old-active");
		const watcher = await DaemonAgentConnection.attach(supervisor, "old-active", { directTransport: false });
		cleanup.push(() => tui.dispose(), () => watcher.dispose());
		const watch = (connection: DaemonAgentConnection) => new Promise<AgentConnectionEvent>((resolve) => connection.subscribe((event) => {
			if (event.type === "session_resynced" || event.type === "closed") resolve(event);
		}));
		const restored = Promise.all([watch(tui), watch(watcher)]);
		script.beginUpdate();
		for (const event of await restored) expect(event.type).toBe("session_resynced");
		expect(script.trace.filter((step) => step.startsWith("accept:"))).toEqual(["accept:0", "accept:1", "accept:2"]);
		expect(direct.close).toHaveBeenCalledOnce();
	});


	it("recovers from the prepared daemon notice even when the worker session notice was missed", async () => {
		const script = await startCutoverScript(false, { predecessorReason: "update" });
		const client = new DaemonClient(script.socketPath);
		cleanup.push(async () => client.close());
		await client.connect();
		await client.waitForHello();
		const connection = await DaemonAgentConnection.attach(client, "old-active");
		cleanup.push(() => connection.dispose());
		const events: AgentConnectionEvent[] = [];
		const restored = new Promise<AgentConnectionEvent>((resolve) => connection.subscribe((event) => {
			events.push(event);
			if (event.type === "session_resynced" || event.type === "closed") resolve(event);
		}));
		script.beginDaemonUpdate();
		expect(await restored).toMatchObject({ type: "session_resynced" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events.filter((event) => event.type === "connection_status" && event.status === "reconnecting")).toHaveLength(1);
		expect(events.some((event) => event.type === "closed")).toBe(false);
	});

	describe("bounded update ownership", () => {

		it("treats a genuine successor shutdown as terminal after update ownership ends", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active");
			cleanup.push(() => connection.dispose());
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "shutdown" });
			await vi.advanceTimersByTimeAsync(100);
			expect(events.filter((event) => event.type === "session_resynced")).toHaveLength(1);
			expect(events.some((event) => event.type === "closed")).toBe(false);
			fake.closeTransport("shutdown");
			await vi.advanceTimersByTimeAsync(240_000);
			const closed = events.filter((event) => event.type === "closed");
			expect(closed).toHaveLength(1);
			expect(closed[0]).toMatchObject({ error: expect.stringContaining("daemon shut down") });
			expect(events.filter((event) => event.type === "session_resynced")).toHaveLength(1);
		});

		it("a deferred-event snapshot failure from the old revision cannot close a restored session", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active", { deferSessionEvents: true });
			cleanup.push(() => connection.dispose());
			const originalRequest = fake.request.getMockImplementation()!;
			let rejectOldRead!: (error: Error) => void;
			let readStarted!: () => void;
			const oldReadStarted = new Promise<void>((resolve) => { readStarted = resolve; });
			fake.request.mockImplementation(async (command, timeout, options) => {
				if (command.type === "attach" && command.activeSessionId === "old-active") {
					return { type: "response", command: "attach", success: true, data: snapshot("old-active", true).snapshot.summary };
				}
				if (command.type === "get_connection_state") {
					readStarted();
					return new Promise<DaemonResponse>((_resolve, reject) => { rejectOldRead = reject; });
				}
				return originalRequest(command, timeout, options);
			});
			for (let index = 0; index <= 1000; index++) {
				fake.emit({ type: "session_event", activeSessionId: "old-active", event: { type: "agent_start" } });
			}
			const flush = connection.flushBufferedSessionEvents();
			await oldReadStarted;
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			await vi.advanceTimersByTimeAsync(100);
			expect(events.filter((event) => event.type === "session_resynced")).toHaveLength(1);
			rejectOldRead(new Error("old read closed after restore"));
			await flush;
			await vi.advanceTimersByTimeAsync(240_000);
			expect(events.some((event) => event.type === "closed")).toBe(false);
		});

		it("an exhausted ordinary reconnect fences later update events instead of reviving after closed", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active", {
				recoverDaemon: async () => { throw new Error("ordinary recovery failed"); }, reconnectTimeoutMs: 1,
			});
			cleanup.push(() => connection.dispose());
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.closeTransport();
			await vi.advanceTimersByTimeAsync(100);
			expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
			const count = events.length;
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			await vi.advanceTimersByTimeAsync(240_000);
			expect(events).toHaveLength(count);
		});
		it("keeps a full 120 seconds for restoration after a late successor hello", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			fake.control.availableAt = 119_000;
			fake.control.restoredAt = 238_000;
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active");
			cleanup.push(() => connection.dispose());
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			await vi.advanceTimersByTimeAsync(120_000);
			expect(events.some((event) => event.type === "closed")).toBe(false);
			expect(events.some((event) => event.type === "session_resynced")).toBe(false);
			await vi.advanceTimersByTimeAsync(118_100);
			expect(events.filter((event) => event.type === "session_resynced")).toHaveLength(1);
			expect(events.some((event) => event.type === "closed")).toBe(false);
		});

		it.each(["unavailable", "missing", "attach", "snapshot"] as const)("emits one diagnostic only at the %s phase deadline and ignores late completions", async (failure) => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			let releaseAttach!: () => void;
			fake.control.attachGate = new Promise<void>((resolve) => { releaseAttach = resolve; });
			if (failure === "unavailable") fake.control.availableAt = Infinity;
			if (failure === "missing") fake.control.restoredAt = Infinity;
			if (failure === "attach" || failure === "snapshot") fake.control.stalled = failure;
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active", { snapshotTimeoutMs: 300_000 });
			cleanup.push(() => connection.dispose());
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			await vi.advanceTimersByTimeAsync(119_999);
			expect(events.some((event) => event.type === "closed")).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			const closed = events.filter((event) => event.type === "closed");
			expect(closed).toHaveLength(1);
			expect(closed[0]).toMatchObject({ error: expect.stringContaining("Session ID: durable-session") });
			expect(closed[0]).toMatchObject({ error: expect.stringContaining("before the recovery timeout expired") });
			const calls = fake.reconnect.mock.calls.length;
			releaseAttach();
			fake.control.availableAt = 0;
			fake.control.restoredAt = 0;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
			expect(events.some((event) => event.type === "session_resynced")).toBe(false);
			expect(events.some((event) => event.type === "connection_status" && event.status === "connected")).toBe(false);
			expect(fake.reconnect.mock.calls).toHaveLength(calls);
		});

		it("stops retrying after the only adapter is disposed", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			fake.control.availableAt = Infinity;
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active");
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			await vi.advanceTimersByTimeAsync(100);
			await connection.dispose();
			const calls = fake.reconnect.mock.calls.length;
			await vi.advanceTimersByTimeAsync(240_000);
			expect(fake.reconnect.mock.calls).toHaveLength(calls);
			expect(events.map((event) => event.type)).toEqual(["connection_status"]);
		});

		it("an obsolete ordinary reconnect cannot reset the updated transport or publish a late terminal", async () => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const fake = controlledTransport();
			let rejectRecovery!: (error: Error) => void;
			const recoverDaemon = () => new Promise<void>((_resolve, reject) => { rejectRecovery = reject; });
			const connection = await DaemonAgentConnection.attach(fake.transport, "old-active", { recoverDaemon, reconnectTimeoutMs: 1 });
			cleanup.push(() => connection.dispose());
			const events: AgentConnectionEvent[] = [];
			connection.subscribe((event) => { events.push(event); });
			fake.closeTransport();
			fake.emit({ type: "session_closed", activeSessionId: "old-active", reason: "update" });
			await vi.advanceTimersByTimeAsync(100);
			expect(events.filter((event) => event.type === "session_resynced")).toHaveLength(1);
			rejectRecovery(new Error("obsolete recovery failed"));
			await vi.advanceTimersByTimeAsync(240_000);
			expect(events.some((event) => event.type === "closed")).toBe(false);
			expect(fake.transport.isConnected).toBe(true);
		});
	});
});
