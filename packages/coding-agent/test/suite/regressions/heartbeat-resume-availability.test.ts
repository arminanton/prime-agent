import { join } from "node:path";
import type { Socket } from "node:net";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBundledSkillsDir } from "../../../src/config.js";
import type { AgentSession } from "../../../src/core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../../src/core/agent-session-config.js";
import type { AgentObserveListResult } from "../../../src/core/agent-observe.js";
import type { AgentSessionRuntime, CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.js";
import type { AgentSessionCreationOptions } from "../../../src/core/agent-session-services.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import type { AgentCronJobStore, AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import { createDefaultRuntimeFactory } from "../../../src/main.js";
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

async function callHostActions(session: AgentSession): Promise<Record<string, HostCallResult>> {
	const tool = session.agent.state.tools.find((entry) => entry.name === "ipython");
	if (!tool) throw new Error("Root session has no ipython tool");
	const result = await tool.execute("host-actions", {
		code: `import json, rlm
results = {}
for request_type, payload in [
    ("rlm_heartbeat.list", {}),
    ("rlm_heartbeat.create", {"instruction": "check resumed work", "interval": "1h", "label": "resume test"}),
    ("agent_message.send", {"target": "all", "message": "test broadcast"}),
    ("agent_observe.list", {}),
]:
    try:
        results[request_type] = {"ok": True, "result": await rlm.host_request(request_type, payload)}
    except Exception as error:
        results[request_type] = {"ok": False, "error": str(error)}
print(json.dumps(results))`,
	});
	expect(result.details).toMatchObject({ status: "ok" });
	const text = result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
	const jsonLine = text.split("\n").find((line) => line.startsWith('{"rlm_heartbeat.list":'));
	if (!jsonLine) throw new Error(`Missing host action results: ${text}`);
	return JSON.parse(jsonLine) as Record<string, HostCallResult>;
}

function expectAvailable(results: Record<string, HostCallResult>): void {
	for (const type of ["rlm_heartbeat.list", "rlm_heartbeat.create", "agent_message.send", "agent_observe.list"]) {
		expect(results[type], `${type}: ${JSON.stringify(results)}`).toMatchObject({ ok: true });
	}
}

describe("daemon root host actions after passive-session resume", () => {
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
			(pi) => pi.registerProvider(model.provider, {
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
				expect(() => controllers.rlmHeartbeatController?.createRlmHeartbeat({
					instruction: "must not reach the previous owner", interval: "1h",
				})).toThrow(/not ready/);
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
		const state = await daemon.createRuntime({ type: "create" });
		states.push(state);
		const original = state.runtime.session;
		const activeSessionId = state.activeSessionId;
		expect(original.rlmDepth).toBe(0);
		expect(prewarm).toHaveBeenCalledTimes(1);
		expectAvailable(await callHostActions(original));
		expect(daemon.sessions.size).toBe(1);
		expect([...daemon.sessions.values()].some((entry) => entry.runtime.session.sessionId === passive.getSessionId())).toBe(false);
		const client: DaemonSocketClient = {
			id: "resume-client",
			socket: { destroyed: false } as Socket,
			attachedActiveSessionIds: new Set([activeSessionId]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		};

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
});
