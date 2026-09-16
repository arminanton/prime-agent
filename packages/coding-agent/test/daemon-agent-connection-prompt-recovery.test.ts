import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionState } from "../src/modes/agent-connection/types.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_INFO, DAEMON_SCHEMA_ID, DAEMON_SCHEMA_REVISION, type DaemonCommand, type DaemonCommandEnvelope } from "../src/modes/daemon/daemon-protocol.js";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";

const state: AgentConnectionState = {
	activeSessionId: "active", sessionId: "session", sessionFile: "/test/session.jsonl", cwd: "/test",
	model: undefined, thinkingLevel: "medium", serviceTier: "default", availableThinkingLevels: ["medium"],
	isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0, steeringMode: "all", followUpMode: "all",
	sessionDir: "/test", leafId: null, autoCompactionEnabled: true, messageCount: 1,
	sessionActions: { queuedCount: 0, steering: [], followUps: [] }, compactionCount: 0,
	goal: { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
	scopedModels: [], activeToolNames: [], contextUsage: undefined,
};
const summary = {
	id: "active", activeSessionId: "active", sessionId: "session", sessionFile: state.sessionFile, cwd: state.cwd,
	lifecycle: "live", activity: "idle", isSessionActive: false, isStreaming: false, isCompacting: false,
	attachedClients: 1, messageCount: 1, sessionActions: state.sessionActions,
};

describe("signal-bearing prompt continuity on non-update loss", () => {
	it.each(["prompt", "prompt_and_wait"] as const)("replays the stable %s envelope after the supervisor re-adopts the running worker", async (type) => {
		const directory = mkdtempSync(join(tmpdir(), "prompt-recovery-"));
		const socketPath = join(directory, "daemon.sock");
		const sockets: Socket[] = [];
		const envelopes: Array<{ id: string | undefined; admissionId: string | undefined; activeSessionId: string }> = [];
		let executions = 0;
		const commands: string[] = [];
		const server = createServer((socket) => {
			const index = sockets.length;
			sockets.push(socket);
			socket.on("error", () => {});
			socket.write(serializeJsonLine({ type: "daemon_hello", socketPath, protocol: DAEMON_PROTOCOL_INFO,
				schemaId: DAEMON_SCHEMA_ID, schemaRevision: DAEMON_SCHEMA_REVISION,
				clientId: `client-${index}`, supervisorGeneration: `supervisor-${index}`,
				serverCapabilities: ["session_input_admission", "prompt_admission_cancellation"] }));
			attachJsonlLineReader(socket, (line) => {
				const wire = JSON.parse(line) as DaemonCommand | DaemonCommandEnvelope;
				const command = wire.type === "command" ? wire.command : wire;
				if (command.type === "ack_result") return;
				commands.push(command.type);
				const reply = (data?: unknown) => socket.write(serializeJsonLine({ type: "response", id: command.id,
					command: command.type, success: true, data }));
				if (command.type === "prompt" || command.type === "prompt_and_wait") {
					envelopes.push({ id: command.id, admissionId: command.admissionId, activeSessionId: command.activeSessionId });
					if (index === 0) {
						executions++;
						// The worker owns the turn. Only its supervisor connection is lost, without an update notice.
						socket.destroy();
					} else {
						// The re-adopted worker/journal returns the result of that same command, not a second execution.
						reply();
					}
				} else if (command.type === "attach") reply(summary);
				else if (command.type === "get_connection_state") reply(state);
				else if (command.type === "get_messages") reply({ messages: [] });
				else if (command.type === "get_session_context") reply({ context: { messages: [], thinkingLevel: "medium", serviceTier: "default", model: null } });
				else if (command.type === "cancel_prompt_admission") reply({ status: "owned" });
				else reply();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => { server.off("error", reject); resolve(); });
		});
		const client = new DaemonClient(socketPath);
		let connection: DaemonAgentConnection | undefined;
		try {
			await client.connect();
			await client.waitForHello();
			connection = await DaemonAgentConnection.attach(client, "active", { recoverDaemon: async () => {} });
			const reconnected = new Promise<void>((resolve) => connection!.subscribe((event) => {
				if (event.type === "connection_status" && event.status === "connected") resolve();
			}));
			const options = { signal: new AbortController().signal };
			const operation = type === "prompt" ? connection.prompt("run once", options) : connection.promptAndWait("run once", options);
			const result = await operation.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
			expect(result).toEqual({ ok: true });
			await reconnected;
			expect(envelopes).toHaveLength(2);
			expect(envelopes[0]?.admissionId).toBeTruthy();
			expect(envelopes[1]).toEqual(envelopes[0]);
			expect(executions).toBe(1);
			expect(commands).not.toContain("cancel_prompt_admission");
		} finally {
			client.close();
			await connection?.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(directory, { recursive: true, force: true });
		}
	}, 10_000);
});
