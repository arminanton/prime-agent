import type { Socket } from "node:net";
import { basename, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBundledSkillsDir } from "../../../src/config.js";
import type { AgentObserveListResult } from "../../../src/core/agent-observe.js";
import type { AgentSession } from "../../../src/core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../../src/core/agent-session-config.js";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.js";
import type { AgentSessionCreationOptions } from "../../../src/core/agent-session-services.js";
import type { AgentCronJobStore, AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import { createDefaultRuntimeFactory } from "../../../src/main.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import { createHarness, type Harness } from "../harness.js";

interface DaemonTestAccess {
	createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
	createRlmSubagentRuntime(state: ActiveSessionState, options: CreateRlmSubagentRuntimeOptions): Promise<AgentSessionRuntime>;
	createAgentObserveListResult(state: ActiveSessionState): Promise<AgentObserveListResult>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	sessions: Map<string, ActiveSessionState>;
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
}

interface HostCallResult {
	ok: boolean;
	result?: Record<string, unknown>;
	error?: string;
}

async function callHostActions(
	session: AgentSession,
	receiver?: AgentSession,
): Promise<Record<string, HostCallResult>> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "ipython");
	if (!tool) throw new Error("Root session has no ipython tool");
	const messagePayload = receiver
		? { receiver_role: "sibling", receiver_name: receiver.sessionId, message: "test direct message" }
		: { target: "all", message: "test broadcast" };
	const result = await tool.execute("host-actions", {
		code: `import json, rlm
results = {}
for request_type, payload in [
    ("rlm_heartbeat.create", {"instruction": "check resumed work", "interval": "1h", "label": "resume test"}),
    ("rlm_heartbeat.list", {}),
    ("agent_message.send", json.loads(${JSON.stringify(JSON.stringify(messagePayload))})),
    ("agent_observe.list", {}),
]:
    try:
        results[request_type] = {"ok": True, "result": await rlm.host_request(request_type, payload)}
    except Exception as error:
        results[request_type] = {"ok": False, "error": str(error)}
print("HOST_ACTION_RESULTS=" + json.dumps(results))`,
	});
	expect(result.details).toMatchObject({ status: "ok" });
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
	const marker = "HOST_ACTION_RESULTS=";
	const jsonLine = text.split("\n").find((line) => line.startsWith(marker));
	if (!jsonLine) throw new Error(`Missing host action results: ${text}`);
	return JSON.parse(jsonLine.slice(marker.length)) as Record<string, HostCallResult>;
}

function expectAvailable(results: Record<string, HostCallResult>): void {
	for (const type of ["rlm_heartbeat.list", "rlm_heartbeat.create", "agent_message.send", "agent_observe.list"]) {
		expect(results[type], `${type}: ${JSON.stringify(results)}`).toMatchObject({ ok: true });
	}
}

function expectBoundHostActions(
	results: Record<string, HostCallResult>,
	daemon: DaemonTestAccess,
	state: ActiveSessionState,
	receiver: ActiveSessionState,
): void {
	expectAvailable(results);
	const session = state.runtime.session;
	const created = results["rlm_heartbeat.create"].result?.heartbeat as { id: string };
	expect(created).toMatchObject({ id: expect.any(String) });
	expect(daemon.cronStore.list().find((job) => job.id === created.id)).toMatchObject({
		activeSessionId: state.activeSessionId,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
		cwd: session.sessionManager.getCwd(),
	});
	const listed = results["rlm_heartbeat.list"].result?.heartbeats as Array<{ id: string }>;
	expect(listed).toContainEqual(created);
	const jobs = daemon.cronStore.listRlmHeartbeats(state.activeSessionId);
	expect(listed.map((heartbeat) => heartbeat.id).sort()).toEqual(jobs.map((job) => job.id).sort());
	for (const job of jobs) {
		expect(job).toMatchObject({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile: session.sessionFile,
		});
	}
	const receipt = results["agent_message.send"].result;
	expect(receipt).toMatchObject({
		id: expect.any(String),
		from: { activeSessionId: state.activeSessionId, sessionId: session.sessionId },
		target: { activeSessionId: receiver.activeSessionId, sessionId: receiver.runtime.session.sessionId },
		message: "test direct message",
		deliveryStatus: "delivered",
	});
	expect(receiver.runtime.session.messages).toContainEqual(
		expect.objectContaining({
			role: "custom",
			customType: "agent_message",
			details: expect.objectContaining({ id: receipt?.id, from: receipt?.from, target: receipt?.target }),
		}),
	);
	expect(results["agent_observe.list"].result).toMatchObject({
		current: {
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			cwd: session.sessionManager.getCwd(),
			isCurrent: true,
		},
		agents: expect.arrayContaining([
			expect.objectContaining({
				activeSessionId: receiver.activeSessionId,
				sessionId: receiver.runtime.session.sessionId,
				relationship: "sibling",
				isCurrent: false,
			}),
		]),
	});
}

function createClient(activeSessionId: string): DaemonSocketClient {
	return {
		id: "replacement-client",
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	};
}

describe("daemon root host actions after session replacement", () => {
	const harnesses: Harness[] = [];
	const states: ActiveSessionState[] = [];
	const daemons: DaemonTestAccess[] = [];

	afterEach(async () => {
		for (const daemon of daemons.splice(0)) daemon.cronScheduler.stop();
		for (const state of states.splice(0)) {
			state.unsubscribe?.();
			await state.runtime.dispose({ kernelSnapshot: false });
		}
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	function createDaemon(harness: Harness) {
		const sessionDir = join(harness.tempDir, "sessions");
		const model = harness.getModel();
		const config: AgentSessionRuntimeConfig = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionDir,
			provider: model.provider,
			model: model.id,
			apiKey: "faux-key",
			tools: ["ipython"],
			noSkills: true,
			skills: [join(getBundledSkillsDir(), "agent-message")],
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			telemetryDisabled: true,
		};
		const productionFactory = createDefaultRuntimeFactory(config, [
			(pi) =>
				pi.registerProvider(model.provider, {
					baseUrl: model.baseUrl,
					apiKey: "faux-key",
					api: harness.faux.api,
					models: harness.models.map((entry) => ({
						id: entry.id,
						name: entry.name,
						api: entry.api,
						reasoning: entry.reasoning,
						input: entry.input,
						cost: entry.cost,
						contextWindow: entry.contextWindow,
						maxTokens: entry.maxTokens,
					})),
				}),
		]);
		const creationOptions: AgentSessionCreationOptions[] = [];
		const factory: CreateAgentSessionRuntimeFactory = async (options) => {
			const result = await productionFactory(options);
			if (options.sessionOptions) {
				const controllers = options.sessionOptions;
				creationOptions.push(controllers);
				// A prewarm request before the factory result is installed has no owner yet.
				expect(() =>
					controllers.rlmHeartbeatController?.createRlmHeartbeat({
						instruction: "must not reach the previous owner",
						interval: "1h",
					}),
				).toThrow(/not ready/);
				expect(() => controllers.agentMessageController?.listAgents()).toThrow(/not ready/);
				expect(() => controllers.agentObserveController?.listAgents()).toThrow(/not ready/);
			}
			return result;
		};
		// Exercise the production daemon factory and command path without binding a socket.
		const daemon = new AgentDaemon(join(harness.tempDir, "unused.sock"), {
			defaultSessionConfig: config,
			createRuntime: factory,
		}) as unknown as DaemonTestAccess;
		daemons.push(daemon);
		return { daemon, creationOptions, model };
	}

	it("keeps heartbeat, message, and observe handlers when a saved root is opened with switch_session", async () => {
		const prewarm = vi.spyOn(IpythonKernelProvisioner.prototype, "prewarm");
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const sessionDir = join(harness.tempDir, "sessions");
		const passive = SessionManager.create(harness.tempDir, sessionDir);
		passive.appendMessage({ role: "user", content: "saved root", timestamp: Date.now() });
		passive.appendMessage(fauxAssistantMessage("saved root ready"));
		passive.flushNow();
		const passiveFile = passive.getSessionFile();
		if (!passiveFile) throw new Error("Missing passive root file");
		const { daemon, creationOptions, model } = createDaemon(harness);
		const state = await daemon.createRuntime({ type: "create" });
		states.push(state);
		const original = state.runtime.session;
		const activeSessionId = state.activeSessionId;
		expect(original.rlmDepth).toBe(0);
		expect(prewarm).toHaveBeenCalledTimes(1);
		expectAvailable(await callHostActions(original));
		expect(daemon.sessions.size).toBe(1);
		expect([...daemon.sessions.values()].some((entry) => entry.runtime.session.sessionId === passive.getSessionId())).toBe(false);
		const client = createClient(activeSessionId);

		await expect(daemon.handleCommand(client, {
			type: "switch_session", activeSessionId, sessionPath: passiveFile,
		})).resolves.toMatchObject({ success: true });

		const resumed = state.runtime.session;
		expect(resumed).not.toBe(original);
		expect(resumed.rlmDepth).toBe(0);
		expect(state.activeSessionId).toBe(activeSessionId);
		expect(resumed.sessionId).toBe(passive.getSessionId());
		expect(prewarm).toHaveBeenCalledTimes(2);
		const family = await daemon.createAgentObserveListResult(state);
		expect(family.agents).toContainEqual(expect.objectContaining({
			sessionId: original.sessionId, relationship: "sibling",
		}));
		const results = await callHostActions(resumed);
		expectAvailable(results);
		const created = results["rlm_heartbeat.create"].result?.heartbeat as { id: string };
		expect(daemon.cronStore.list().find((job) => job.id === created.id)).toMatchObject({
			activeSessionId,
			sessionId: passive.getSessionId(),
			sessionFile: passiveFile,
		});
		expect(results["agent_message.send"].result).toMatchObject({ receipts: expect.any(Array) });
		expect(results["agent_observe.list"].result).toMatchObject({
			current: { activeSessionId, sessionId: passive.getSessionId() },
		});
		expect(creationOptions).toHaveLength(2);
		for (const key of ["rlmHeartbeatController", "agentMessageController", "agentObserveController"] as const) {
			expect(creationOptions[1][key]).toBeDefined();
			expect(creationOptions[1][key]).not.toBe(creationOptions[0][key]);
		}
		expect(() => creationOptions[0].rlmHeartbeatController!.createRlmHeartbeat({
			instruction: "retired controller", interval: "1h",
		})).toThrow(/not ready/);

		const child = await daemon.createRlmSubagentRuntime(state, {
			id: "child-controller-check",
			parentSession: resumed,
			sessionName: "child-controller-check",
			sessionDir: join(harness.tempDir, "sub-child-controller-check"),
			prompt: "child fixture",
			model,
			thinkingLevel: "off",
			serviceTier: null,
			scopedModels: [],
			activeToolNames: [],
			allowedToolNames: [],
			customTools: [],
			includeGoals: false,
			includeCompactSkill: false,
			rlmDepth: 1,
			rlmMaxDepth: 3,
			rlmParentNodeId: "child-controller-check",
			spawnedByRequestId: "a".repeat(32),
		});
		const childState = [...daemon.sessions.values()].find((entry) => entry.runtime === child);
		if (!childState) throw new Error("Missing child state");
		states.push(childState);
		await child.newSession();
		expect(child.session.rlmDepth).toBe(1);
		expect(creationOptions).toHaveLength(4);
		for (const options of creationOptions.slice(2)) {
			expect(options).toMatchObject({
				rlmDepth: 1, rlmMaxDepth: 3, rlmParentNodeId: "child-controller-check",
				allowedToolNames: [], initialActiveToolNames: [], includeGoals: false,
				includeCompactSkill: false, semanticParentSessionId: resumed.sessionId,
				semanticSpawnedByRequestId: "a".repeat(32),
			});
		}
		const childHeartbeat = creationOptions[3].rlmHeartbeatController!.createRlmHeartbeat({
			instruction: "child owner", interval: "1h",
		});
		expect(childHeartbeat).toMatchObject({
			activeSessionId: childState.activeSessionId,
			sessionId: child.session.sessionId,
			sessionFile: child.session.sessionFile,
		});
		expect(childHeartbeat.activeSessionId).not.toBe(activeSessionId);
		expect(creationOptions[1].rlmHeartbeatController!.createRlmHeartbeat({
			instruction: "root owner after child replacement", interval: "1h",
		})).toMatchObject({ activeSessionId, sessionId: resumed.sessionId, sessionFile: passiveFile });
		expect(prewarm).toHaveBeenCalledTimes(2);
	}, 60_000);

	it.each(["newSession", "fork", "import"] as const)(
		"keeps host actions callable and bound to the current root after %s",
		async (operation) => {
			const harness = await createHarness({ tools: [] });
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage("first message received"),
				fauxAssistantMessage("replacement message received"),
			]);
			const { daemon } = createDaemon(harness);
			const state = await daemon.createRuntime({ type: "create" });
			states.push(state);
			const receiver = await daemon.createRuntime({ type: "create", config: { tools: [] } });
			states.push(receiver);
			const receiverFile = receiver.runtime.session.sessionFile;
			if (!receiverFile) throw new Error("Missing receiver session file");
			// The current root's list must not include another root's heartbeat.
			daemon.cronStore.createRlmHeartbeat({
				activeSessionId: receiver.activeSessionId,
				sessionId: receiver.runtime.session.sessionId,
				sessionFile: receiverFile,
				cwd: harness.tempDir,
				prompt: "receiver heartbeat",
				scheduleText: "every 1h",
			});
			const original = state.runtime.session;
			const activeSessionId = state.activeSessionId;
			expect(original.rlmDepth).toBe(0);
			expectBoundHostActions(await callHostActions(original, receiver.runtime.session), daemon, state, receiver);
			await receiver.runtime.session.agent.waitForIdle();

			let command: DaemonCommand = { type: "new_session", activeSessionId };
			let imported: { sessionId: string; sessionFile: string } | undefined;
			if (operation === "fork") {
				original.sessionManager.appendMessage({ role: "user", content: "fork source", timestamp: Date.now() });
				const entryId = original.sessionManager.appendMessage(fauxAssistantMessage("fork source ready"));
				original.sessionManager.flushNow();
				command = { type: "fork", activeSessionId, entryId, position: "at" };
			} else if (operation === "import") {
				const source = SessionManager.create(harness.tempDir, join(harness.tempDir, "imports"));
				source.appendMessage({ role: "user", content: "import source", timestamp: Date.now() });
				source.appendMessage(fauxAssistantMessage("import source ready"));
				source.flushNow();
				const inputPath = source.getSessionFile();
				if (!inputPath) throw new Error("Missing import source file");
				imported = {
					sessionId: source.getSessionId(),
					sessionFile: join(original.sessionManager.getSessionDir(), basename(inputPath)),
				};
				command = { type: "import_jsonl", activeSessionId, inputPath };
			}
			await expect(daemon.handleCommand(createClient(activeSessionId), command)).resolves.toMatchObject({
				success: true,
				data: { cancelled: false },
			});

			const replacement = state.runtime.session;
			expect(replacement).not.toBe(original);
			expect(replacement.rlmDepth).toBe(0);
			expect(state.activeSessionId).toBe(activeSessionId);
			expect(replacement.sessionId).not.toBe(original.sessionId);
			expect(replacement.sessionFile).toBeDefined();
			expect(replacement.sessionFile).not.toBe(original.sessionFile);
			if (operation === "fork") {
				expect(replacement.sessionManager.getHeader()?.parentSession).toBe(original.sessionFile);
			}
			if (imported) {
				expect(replacement.sessionId).toBe(imported.sessionId);
				expect(replacement.sessionFile).toBe(imported.sessionFile);
			}
			expectBoundHostActions(await callHostActions(replacement, receiver.runtime.session), daemon, state, receiver);
			await receiver.runtime.session.agent.waitForIdle();
			expect(harness.getPendingResponseCount()).toBe(0);
		},
		60_000,
	);
});
