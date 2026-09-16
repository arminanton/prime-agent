import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Container, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyGoalState } from "../src/core/goals.js";
import { createSessionSlashCommandMessage, createSessionSlashCommandResultMessage } from "../src/core/messages.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionSessionEvent,
	AgentConnectionState,
} from "../src/modes/agent-connection/index.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import type { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { initTheme, stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

vi.mock("../src/utils/tools-manager.js", () => ({
	ensureTool: vi.fn(async () => undefined),
	ensureToolWithStatus: vi.fn(async () => ({
		status: "unavailable",
		reason: "offline",
		platform: "linux",
		architecture: "x64",
	})),
	getToolPath: vi.fn(() => null),
	formatMissingRipgrepMessage: vi.fn(() => "Offline test fixture"),
}));

type ModeControls = {
	chatContainer: Container;
	statusContainer: Container;
	defaultEditor: CustomEditor;
	subagentSummaryLine: SubagentSummaryLine;
	ui: TUI;
	subscribeToAgent(): void;
	subscribeToRosterBar(): Promise<void>;
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
};

const fixtures: Array<{ mode: InteractiveMode; harness: Harness }> = [];
afterEach(() => {
	for (const { mode, harness } of fixtures.splice(0)) {
		mode.stop();
		harness.cleanup();
	}
	stopThemeWatcher();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function state(overrides: Partial<AgentConnectionState> = {}): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/tmp/reconnect-fixture",
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["medium"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: emptyGoalState(),
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
		...overrides,
	};
}

async function createUi(initialState = state()) {
	initTheme("dark");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Unexpected network request");
		}),
	);
	const harness = await createHarness({ tools: [] });
	let listener: AgentConnectionEventListener | undefined;
	let rosterListener: (() => void) | undefined;
	let rosterRows: SessionSummary[] = [];
	const connection = {
		onBeforeSessionInvalidate: () => () => {},
		subscribe: (callback: AgentConnectionEventListener) => {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
		subscribeAgentRoster: vi.fn(async (callback: () => void) => {
			rosterListener = callback;
			return { summaries: () => rosterRows, dispose: vi.fn(async () => {}) };
		}),
		getState: vi.fn(async () => initialState),
		getInitialSnapshot: vi.fn(async () => ({ state: initialState, messages: [], children: [] })),
		getModelCatalog: vi.fn(async () => ({ models: [], configuredProviders: [] })),
		getResourceSnapshot: vi.fn(async () => ({
			contextFiles: [],
			skills: [],
			prompts: [],
			extensions: [],
			themes: [],
			diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
		})),
		getCommands: vi.fn<AgentConnection["getCommands"]>(async () => []),
		getToolDefinition: vi.fn(async () => undefined),
		getContextTree: vi.fn(async () => undefined),
		listHeartbeats: vi.fn(async () => []),
		prompt: vi.fn<AgentConnection["prompt"]>(async () => {}),
		mutateQueuedMessage: vi.fn<AgentConnection["mutateQueuedMessage"]>(async () => "applied"),
		abort: vi.fn(async () => {}),
		clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
		dispose: vi.fn(async () => {}),
	};
	const mode = new InteractiveMode({
		agentConnection: connection as unknown as AgentConnection,
		uiServices: createInteractiveModeUiServices(harness.session),
		returnToAgentsView: true,
	});
	fixtures.push({ mode, harness });
	const controls = mode as unknown as ModeControls;
	const requestRender = vi.spyOn(controls.ui, "requestRender").mockImplementation(() => {});
	vi.spyOn(controls.ui, "stop").mockImplementation(() => {});
	vi.spyOn(controls.ui.terminal, "setProgress").mockImplementation(() => {});
	vi.spyOn(controls.ui.terminal, "setTitle").mockImplementation(() => {});
	Object.assign(mode, { connectionState: initialState, isInitialized: true });
	controls.setupKeyHandlers();
	controls.setupEditorSubmitHandler();
	controls.subscribeToAgent();
	await controls.subscribeToRosterBar();
	const emit = async (event: AgentConnectionEvent) => {
		if (event.type === "session_replaced") initialState = event.state;
		if (event.type === "session_resynced") initialState = event.snapshot.state;
		await listener?.(event);
	};
	const updateRoster = (rows: SessionSummary[]) => {
		rosterRows = rows;
		rosterListener?.();
	};
	return { mode, controls, harness, connection, emit, requestRender, updateRoster };
}

async function createTraceUi() {
	const ui = await createUi();
	const sessionDir = join(ui.harness.tempDir, "manual-traces");
	mkdirSync(sessionDir);
	const sessionFile = join(sessionDir, "trace.jsonl");
	writeFileSync(
		sessionFile,
		`${[
			{
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "trace-fixture",
				timestamp: new Date().toISOString(),
				cwd: ui.harness.tempDir,
			},
			{ type: "message", id: "answer", parentId: null, message: fauxAssistantMessage("Persisted answer") },
		]
			.map((entry) => JSON.stringify(entry))
			.join("\n")}\n`,
	);
	ui.harness.authStorage.set(PRIME_AGENT_TRACES_PROVIDER_ID, { type: "api_key", key: "trace-fixture-key" });
	const traceState = state({ sessionDir, sessionFile });
	ui.connection.getState.mockResolvedValue(traceState);
	const submit = (text: string) => {
		ui.controls.defaultEditor.setText(text);
		// The real editor clears before invoking its public onSubmit callback.
		ui.controls.defaultEditor.setText("");
		return ui.controls.defaultEditor.onSubmit?.(text);
	};
	return { ...ui, traceState, submit };
}

function roster(children: Array<[string, "running" | "idle"]>): SessionSummary[] {
	return [
		{ id: "active-1", activeSessionId: "active-1", sessionId: "session-1", lifecycle: "live" } as SessionSummary,
		...children.map(
			([id, rosterStatus]) =>
				({
					id,
					activeSessionId: `active-${id}`,
					sessionId: id,
					lifecycle: "live",
					runtimeKind: "subagent",
					rlmChildId: id,
					parentSessionId: "session-1",
					rosterStatus,
				}) as SessionSummary,
		),
	];
}

function render(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode reconnect UI", () => {
	it("clears a stale working indicator without clearing the transcript or draft", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "session_event", event: { type: "agent_start" } });
		await ui.emit({
			type: "session_event",
			event: { type: "message_start", message: fauxAssistantMessage("Partial answer") },
		});
		ui.controls.defaultEditor.setText("Keep this draft");
		expect(render(ui.controls.statusContainer)).toContain("Waiting");

		await ui.emit({ type: "connection_status", status: "reconnecting" });

		expect(render(ui.controls.statusContainer)).toBe("");
		expect(render(ui.controls.chatContainer)).toContain("Partial answer");
		expect(ui.controls.defaultEditor.getText()).toBe("Keep this draft");
		ui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(2000);
		expect(render(ui.controls.statusContainer)).toBe("");
		expect(ui.requestRender).not.toHaveBeenCalled();
		expect(ui.connection.abort).not.toHaveBeenCalled();
		expect(ui.connection.clearQueue).not.toHaveBeenCalled();
		expect(ui.connection.dispose).not.toHaveBeenCalled();
	});
	it.each<[string, AgentConnectionSessionEvent]>([
		["compaction", { type: "compaction_start", reason: "manual" }],
		[
			"refinement",
			{
				type: "message_start",
				message: createSessionSlashCommandMessage({ name: "refine", args: "", text: "/refine" }),
			},
		],
		["retry", { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10_000, errorMessage: "fixture" }],
	])("stops the stale %s timer instead of only detaching its loader", async (_label, event) => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "session_event", event });
		expect(render(ui.controls.statusContainer).trim()).not.toBe("");
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		ui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(2000);
		expect(render(ui.controls.statusContainer)).toBe("");
		expect(ui.requestRender).not.toHaveBeenCalled();
	});

	it("restores working state after a connected event without a resync", async () => {
		const ui = await createUi();
		ui.harness.settingsManager.setShowTerminalProgress(true);
		vi.useFakeTimers();
		await ui.emit({ type: "session_event", event: { type: "agent_start" } });
		expect(ui.controls.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		expect(ui.controls.ui.terminal.setProgress).toHaveBeenLastCalledWith(false);
		await ui.emit({ type: "connection_status", status: "connected" });
		expect(render(ui.controls.statusContainer)).toContain("Waiting");
		expect(ui.controls.ui.terminal.setProgress).toHaveBeenLastCalledWith(true);
	});

	it("waits for a back-to-back resync before releasing the reconnect presentation", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "session_event", event: { type: "agent_start" } });
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		const catalog = deferred<Awaited<ReturnType<AgentConnection["getCommands"]>>>();
		ui.connection.getCommands.mockImplementation(() => catalog.promise);
		const resync = ui.emit({
			type: "session_resynced",
			snapshot: {
				state: state(),
				messages: [{ role: "user", content: "Fresh transcript", timestamp: 1 }],
				children: [],
			},
		});
		const connected = ui.emit({ type: "connection_status", status: "connected" });
		await Promise.resolve();
		expect(render(ui.controls.statusContainer)).toBe("");
		catalog.resolve([]);
		await Promise.all([resync, connected]);
		expect(render(ui.controls.statusContainer)).toBe("");
		expect(render(ui.controls.chatContainer)).toContain("Fresh transcript");
	});

	it("does not remount old working state from a child-status refresh during the gap", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "session_event", event: { type: "agent_start" } });
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		await ui.emit({
			type: "session_event",
			event: {
				type: "rlm_child_update",
				child: { id: "child", label: "child", status: "done", sessionDir: "/tmp/child" },
			},
		});
		expect(render(ui.controls.statusContainer)).toBe("");
		ui.requestRender.mockClear();
		await vi.advanceTimersByTimeAsync(2000);
		expect(ui.requestRender).not.toHaveBeenCalled();
	});

	it.each(["retry", "refinement"] as const)("preserves fresh live %s events over a held direct link", async (kind) => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		const command = { name: "refine", args: "", text: "/refine" } as const;
		await ui.emit({
			type: "session_event",
			event:
				kind === "retry"
					? { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10_000, errorMessage: "fixture" }
					: { type: "message_start", message: createSessionSlashCommandMessage(command) },
		});
		const label = kind === "retry" ? "Retrying" : "Refining";
		expect(render(ui.controls.statusContainer)).toContain(label);
		await ui.emit({ type: "connection_status", status: "connected" });
		expect(render(ui.controls.statusContainer)).toContain(label);
		await ui.emit({
			type: "session_event",
			event:
				kind === "retry"
					? { type: "auto_retry_end", success: true, attempt: 1 }
					: {
							type: "message_start",
							message: createSessionSlashCommandResultMessage(
								"Refined",
								{ command, success: true, severity: "info" },
								false,
							),
						},
		});
		expect(render(ui.controls.statusContainer)).not.toContain(label);
	});

	it.each(["idle", "paused", "active"] as const)(
		"restores a %s goal tray from the resync, not stale local timers",
		async (status) => {
			const ui = await createUi();
			vi.useFakeTimers();
			const activeGoal = {
				...emptyGoalState(),
				goalId: "goal",
				objective: "Fixture goal",
				active: true,
				status: "active",
				timeUsedSeconds: 10,
			} as const;
			await ui.emit({ type: "session_event", event: { type: "goal_update", goal: activeGoal } });
			const tray = () => stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
			expect(tray()).toContain("Pursuing goal");
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			expect(tray()).not.toContain("Pursuing goal");
			ui.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(2000);
			expect(ui.requestRender).not.toHaveBeenCalled();
			const goal =
				status === "idle"
					? emptyGoalState()
					: { ...activeGoal, active: status === "active", status, timeUsedSeconds: 20 };
			const resync = ui.emit({
				type: "session_resynced",
				snapshot: { state: state({ goal }), messages: [], children: [] },
			});
			const connected = ui.emit({ type: "connection_status", status: "connected" });
			await Promise.all([resync, connected]);
			if (status === "idle") expect(tray()).not.toContain("goal");
			else expect(tray()).toContain(status === "active" ? "Pursuing goal (20s)" : "Goal paused (20s)");
			expect(render(ui.controls.chatContainer)).not.toContain("Fixture goal");
			ui.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(2000);
			if (status === "active") expect(ui.requestRender).toHaveBeenCalledTimes(2);
			else expect(ui.requestRender).not.toHaveBeenCalled();
		},
	);

	it("uses fresh child snapshots until a roster callback proves the cached roster refreshed", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		ui.updateRoster(
			roster([
				["one", "running"],
				["two", "running"],
			]),
		);
		const tray = () => stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
		expect(tray()).toContain("2 running");
		ui.controls.defaultEditor.actionHandlers.get("app.subagents.focus")?.();
		expect(ui.controls.subagentSummaryLine.focused).toBe(true);
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		expect(tray()).not.toContain("running");
		expect(ui.controls.subagentSummaryLine.isSelectable()).toBe(false);
		expect(ui.controls.defaultEditor.focused).toBe(true);
		const resync = ui.emit({
			type: "session_resynced",
			snapshot: {
				state: state(),
				messages: [],
				children: [{ id: "one", label: "one", status: "done", sessionDir: "/tmp/one" }],
			},
		});
		const connected = ui.emit({ type: "connection_status", status: "connected" });
		await Promise.all([resync, connected]);
		expect(tray()).toContain("0 running");
		expect(tray()).toContain("1 inactive");
		expect(ui.controls.defaultEditor.focused).toBe(true);
		ui.updateRoster(roster([["one", "running"]]));
		expect(tray()).toContain("1 running");
		expect(tray()).toContain("0 inactive");
		expect(ui.controls.defaultEditor.focused).toBe(true);
	});

	it("keeps snapshot counts when a roster callback precedes gap release", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		ui.updateRoster(roster([["old", "running"]]));
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		ui.updateRoster(roster([["live", "idle"]]));
		const resync = ui.emit({
			type: "session_resynced",
			snapshot: {
				state: state(),
				messages: [],
				children: [{ id: "old", label: "old", status: "done", sessionDir: "/tmp/old" }],
			},
		});
		const connected = ui.emit({ type: "connection_status", status: "connected" });
		await Promise.all([resync, connected]);
		let tray = stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
		expect(tray).toContain("0 idle");
		expect(tray).toContain("1 inactive");
		ui.updateRoster(roster([["live", "idle"]]));
		tray = stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
		expect(tray).toContain("1 idle");
		expect(tray).toContain("0 inactive");
	});

	it.each([false, true])(
		"uses snapshot counts after connected without resync (during-gap callback: %s)",
		async (callback) => {
			const ui = await createUi();
			vi.useFakeTimers();
			ui.updateRoster(
				roster([
					["old", "running"],
					["removed", "running"],
				]),
			);
			await ui.emit({
				type: "session_event",
				event: {
					type: "rlm_child_update",
					child: { id: "old", label: "old", status: "done", sessionDir: "/tmp/old" },
				},
			});
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			if (callback) ui.updateRoster(roster([["old", "idle"]]));
			await ui.emit({ type: "connection_status", status: "connected" });
			let tray = stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
			expect(tray).toContain("1 inactive");
			expect(tray).toContain("0 running");
			ui.updateRoster(roster([["old", "idle"]]));
			tray = stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
			expect(tray).toContain("1 idle");
			expect(tray).toContain("0 inactive");
			expect(ui.connection.subscribeAgentRoster).toHaveBeenCalledOnce();
			expect(ui.connection.getCommands).not.toHaveBeenCalled();
			expect(ui.connection.dispose).not.toHaveBeenCalled();
		},
	);

	it("does not release a pending connected presentation after a terminal closed event", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		const catalog = deferred<Awaited<ReturnType<AgentConnection["getCommands"]>>>();
		ui.connection.getCommands.mockImplementation(() => catalog.promise);
		const resync = ui.emit({
			type: "session_resynced",
			snapshot: { state: state({ isStreaming: true }), messages: [], children: [] },
		});
		const connected = ui.emit({ type: "connection_status", status: "connected" });
		await ui.emit({ type: "closed", error: "Genuine terminal failure" });
		catalog.resolve([]);
		await Promise.all([resync, connected]);
		expect(render(ui.controls.statusContainer)).toBe("");
		expect(ui.connection.listHeartbeats).not.toHaveBeenCalled();
		expect(ui.connection.dispose).not.toHaveBeenCalled();
	});

	it("releases only local gap presentation when a true session replacement resets the view", async () => {
		const ui = await createUi();
		vi.useFakeTimers();
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		await ui.emit({
			type: "session_replaced",
			state: state({ sessionId: "replacement", isStreaming: true }),
			messages: [],
		});
		expect(render(ui.controls.statusContainer)).toContain("Waiting");
	});

	it.each(["upload", "upload-current", "on", "enable", "upload-all"])(
		"aborts /traces %s and fences late success and editor clearing",
		async (command) => {
			const ui = await createTraceUi();
			const requested = deferred<AbortSignal>();
			const response = deferred<Response>();
			const fetchMock = vi.fn<typeof fetch>((_url, init) => {
				if (!init?.signal) throw new Error("Expected request signal");
				requested.resolve(init.signal);
				return response.promise;
			});
			vi.stubGlobal("fetch", fetchMock);
			const operation = ui.submit(`/traces ${command}`);
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
			const signal = await requested.promise;
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			await ui.emit({ type: "connection_status", status: "connected" });
			ui.controls.defaultEditor.setText("New draft after reconnect");
			response.resolve(new Response(JSON.stringify({ bytes_stored: 12 }), { status: 200 }));
			await operation;
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toEqual(new Error("Trace upload cancelled during daemon reconnect"));
			expect(ui.controls.defaultEditor.getText()).toBe("New draft after reconnect");
			const output = render(ui.controls.chatContainer);
			expect(output).toContain("Daemon reconnected");
			expect(output).not.toMatch(/Trace uploaded|Uploaded 1 of|Trace sharing enabled|Trace upload cancelled\./);
			expect(output).not.toContain("Uploading traces: 1/1");
		},
	);

	it.each(["upload", "upload-current", "on", "enable", "upload-all"])(
		"does not start /traces %s after reconnect interrupts getState",
		async (command) => {
			const ui = await createTraceUi();
			const snapshot = deferred<AgentConnectionState>();
			ui.connection.getState.mockImplementation(() => snapshot.promise);
			const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
			vi.stubGlobal("fetch", fetchMock);
			const operation = ui.submit(`/traces ${command}`);
			await vi.waitFor(() => expect(ui.connection.getState).toHaveBeenCalledOnce());
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			await ui.emit({ type: "connection_status", status: "connected" });
			ui.controls.defaultEditor.setText("Keep newer typing");
			snapshot.resolve(ui.traceState);
			await operation;
			expect(fetchMock).not.toHaveBeenCalled();
			expect(ui.controls.defaultEditor.getText()).toBe("Keep newer typing");
		},
	);

	it("preserves the enabled setting but does not upload after reconnect interrupts its flush", async () => {
		const ui = await createTraceUi();
		const flushed = deferred<void>();
		const flush = vi.spyOn(ui.harness.settingsManager, "flush").mockImplementation(() => flushed.promise);
		const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const operation = ui.submit("/traces on");
		await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		flushed.resolve();
		await operation;
		expect(ui.harness.settingsManager.getAgentTracesEnabled()).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(["upload", "upload-current", "on", "enable", "upload-all"])(
		"fences /traces %s while credentials are still loading",
		async (command) => {
			const ui = await createTraceUi();
			const credential = deferred<string | undefined>();
			const readKey = vi.spyOn(ui.harness.authStorage, "getApiKey").mockImplementation(() => credential.promise);
			const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
			vi.stubGlobal("fetch", fetchMock);
			const operation = ui.submit(`/traces ${command}`);
			await vi.waitFor(() => expect(readKey).toHaveBeenCalled());
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			credential.resolve("trace-fixture-key");
			await operation;
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("does not erase newer typing after a slow trace command without reconnect", async () => {
		const ui = await createTraceUi();
		const response = deferred<Response>();
		const fetchMock = vi.fn<typeof fetch>(() => response.promise);
		vi.stubGlobal("fetch", fetchMock);
		const operation = ui.submit("/traces upload-current");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		ui.controls.defaultEditor.setText("Typed while upload was running");
		response.resolve(new Response("{}", { status: 200 }));
		await operation;
		expect(ui.controls.defaultEditor.getText()).toBe("Typed while upload was running");
	});

	it.each(["retained", "removed", "edited"] as const)(
		"preserves queue drafts through reconnect and revalidates a %s tuple",
		async (outcome) => {
			const ui = await createUi(state({ sessionActions: { queuedCount: 1, steering: [], followUps: ["queued"] } }));
			ui.controls.defaultEditor.setText("Original draft");
			ui.controls.defaultEditor.actionHandlers.get("app.message.navigateOlder")?.();
			expect(ui.controls.defaultEditor.getText()).toBe("queued");
			if (outcome === "edited") ui.controls.defaultEditor.setText("Edited queued message");
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			expect(ui.controls.defaultEditor.getText()).toBe(outcome === "edited" ? "Edited queued message" : "queued");
			const actions =
				outcome === "retained"
					? { queuedCount: 1, steering: [], followUps: ["queued"] }
					: { queuedCount: 0, steering: [], followUps: [] };
			const resync = ui.emit({
				type: "session_resynced",
				snapshot: { state: state({ sessionActions: actions }), messages: [], children: [] },
			});
			const connected = ui.emit({ type: "connection_status", status: "connected" });
			await Promise.all([resync, connected]);
			if (outcome === "retained") {
				expect(ui.controls.defaultEditor.getHeaderLine?.()).toContain("follow-up 1");
				ui.controls.defaultEditor.actionHandlers.get("app.message.navigateNewer")?.();
			} else expect(ui.controls.defaultEditor.getHeaderLine?.()).toBeUndefined();
			expect(ui.controls.defaultEditor.getText()).toBe(
				outcome === "edited" ? "Edited queued message" : "Original draft",
			);
			expect(ui.connection.mutateQueuedMessage).not.toHaveBeenCalled();
			expect(ui.connection.clearQueue).not.toHaveBeenCalled();
		},
	);

	it.each(["applied", "rejected"] as const)(
		"keeps newer typing when an in-flight queue edit is %s after resync",
		async (result) => {
			const ui = await createUi(state({ sessionActions: { queuedCount: 1, steering: [], followUps: ["queued"] } }));
			const mutation = deferred<"applied" | "rejected">();
			ui.connection.mutateQueuedMessage.mockReturnValue(mutation.promise);
			ui.controls.defaultEditor.setText("Original draft");
			ui.controls.defaultEditor.actionHandlers.get("app.message.navigateOlder")?.();
			ui.controls.defaultEditor.setText("");
			const submitted = ui.controls.defaultEditor.onSubmit?.("Edited queued message");
			await vi.waitFor(() => expect(ui.connection.mutateQueuedMessage).toHaveBeenCalledOnce());
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			const resync = ui.emit({ type: "session_resynced", snapshot: { state: state(), messages: [], children: [] } });
			const connected = ui.emit({ type: "connection_status", status: "connected" });
			await Promise.all([resync, connected]);
			ui.controls.defaultEditor.setText("Newer typing");
			mutation.resolve(result);
			await submitted;
			expect(ui.controls.defaultEditor.getText()).toBe("Newer typing");
			expect(ui.controls.defaultEditor.getHeaderLine?.()).toBeUndefined();
			expect(ui.connection.prompt).not.toHaveBeenCalled();
		},
	);

	it("revalidates a pending queue move after the resync without losing newer typing", async () => {
		const ui = await createUi(state({ sessionActions: { queuedCount: 2, steering: [], followUps: ["one", "two"] } }));
		const mutation = deferred<"applied">();
		ui.connection.mutateQueuedMessage.mockReturnValue(mutation.promise);
		ui.controls.defaultEditor.setText("Original draft");
		ui.controls.defaultEditor.actionHandlers.get("app.message.navigateOlder")?.();
		ui.controls.defaultEditor.actionHandlers.get("app.message.moveEarlier")?.();
		await vi.waitFor(() => expect(ui.connection.mutateQueuedMessage).toHaveBeenCalledOnce());
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		const resync = ui.emit({ type: "session_resynced", snapshot: { state: state(), messages: [], children: [] } });
		const connected = ui.emit({ type: "connection_status", status: "connected" });
		await Promise.all([resync, connected]);
		ui.controls.defaultEditor.setText("Newer typing");
		mutation.resolve("applied");
		await vi.waitFor(() => expect(ui.controls.defaultEditor.getHeaderLine?.()).toBeUndefined());
		expect(ui.controls.defaultEditor.getText()).toBe("Newer typing");
	});

	it("discards an old queue selection only on a true session replacement", async () => {
		const ui = await createUi(state({ sessionActions: { queuedCount: 1, steering: [], followUps: ["queued"] } }));
		ui.controls.defaultEditor.setText("Old draft");
		ui.controls.defaultEditor.actionHandlers.get("app.message.navigateOlder")?.();
		await ui.emit({ type: "session_replaced", state: state({ sessionId: "replacement" }), messages: [] });
		expect(ui.controls.defaultEditor.getText()).toBe("");
		expect(ui.controls.defaultEditor.getHeaderLine?.()).toBeUndefined();
		await ui.controls.defaultEditor.onSubmit?.("Next session prompt");
		expect(ui.connection.prompt).toHaveBeenCalledWith("Next session prompt", expect.anything());
		expect(ui.connection.mutateQueuedMessage).not.toHaveBeenCalled();
	});

	it("keeps a manual prompt stash behind newer typing when a trace settles after reconnect", async () => {
		const ui = await createTraceUi();
		ui.controls.defaultEditor.setText("Manually stashed draft");
		ui.controls.defaultEditor.actionHandlers.get("app.prompt.stash")?.();
		const response = deferred<Response>();
		const fetchMock = vi.fn<typeof fetch>(() => response.promise);
		vi.stubGlobal("fetch", fetchMock);
		const operation = ui.submit("/traces upload-current");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		await ui.emit({ type: "connection_status", status: "connected" });
		ui.controls.defaultEditor.setText("Newer typing");
		response.resolve(new Response("{}", { status: 200 }));
		await operation;
		expect(ui.controls.defaultEditor.getText()).toBe("Newer typing");
		ui.controls.defaultEditor.setText("");
		ui.controls.defaultEditor.actionHandlers.get("app.prompt.stash")?.();
		expect(ui.controls.defaultEditor.getText()).toBe("Manually stashed draft");
	});

	it("keeps explicit Ctrl+C upload-all cancellation separate from reconnect cancellation", async () => {
		const ui = await createTraceUi();
		const fetchMock = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const operation = ui.submit("/traces upload-all");
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		ui.controls.defaultEditor.actionHandlers.get("app.clear")?.();
		await operation;
		expect(render(ui.controls.chatContainer)).toContain("Trace upload cancelled.");
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.reason).toEqual(new Error("Trace upload cancelled"));
	});

	it.each(["upload-current", "on"])("does not add /traces %s to Ctrl+C cancellation policy", async (command) => {
		const ui = await createTraceUi();
		const response = deferred<Response>();
		const fetchMock = vi.fn<typeof fetch>(() => response.promise);
		vi.stubGlobal("fetch", fetchMock);
		const operation = ui.submit(`/traces ${command}`);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		const signal = fetchMock.mock.calls[0]?.[1]?.signal;
		ui.controls.defaultEditor.actionHandlers.get("app.clear")?.();
		expect(signal?.aborted).toBe(false);
		await ui.emit({ type: "connection_status", status: "reconnecting" });
		response.resolve(new Response("{}", { status: 200 }));
		await operation;
		expect(signal?.aborted).toBe(true);
	});

	it.each(["upload-current", "upload-all"])(
		"suppresses /traces %s completion after response headers already arrived",
		async (command) => {
			const ui = await createTraceUi();
			const body = deferred<string>();
			const response = new Response(null, { status: 200 });
			const readBody = vi.spyOn(response, "text").mockImplementation(() => body.promise);
			vi.stubGlobal(
				"fetch",
				vi.fn<typeof fetch>(async () => response),
			);
			const operation = ui.submit(`/traces ${command}`);
			await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
			await ui.emit({ type: "connection_status", status: "reconnecting" });
			await ui.emit({ type: "connection_status", status: "connected" });
			ui.controls.defaultEditor.setText("Keep this draft");
			body.resolve("{}");
			await operation;
			expect(render(ui.controls.chatContainer)).toContain("Daemon reconnected");
			expect(render(ui.controls.chatContainer)).not.toMatch(/Trace uploaded|Uploaded 1 of|Trace upload cancelled\./);
			expect(ui.controls.defaultEditor.getText()).toBe("Keep this draft");
		},
	);
	it("ignores a pre-gap roster callback delivered after reconnecting", async () => {
		const ui = await createUi();
		ui.updateRoster(
			roster([
				["one", "running"],
				["two", "running"],
			]),
		);
		const rosterListener = ui.connection.subscribeAgentRoster.mock.calls[0]?.[0];
		if (!rosterListener) throw new Error("Expected the registered roster listener");
		const order: string[] = [];
		queueMicrotask(() => {
			order.push("pre-gap roster callback");
			rosterListener();
		});
		order.push("reconnecting");
		const reconnecting = ui.emit({ type: "connection_status", status: "reconnecting" });
		await reconnecting;
		expect(order).toEqual(["reconnecting", "pre-gap roster callback"]);
		const resync = ui.emit({
			type: "session_resynced",
			snapshot: {
				state: state(),
				messages: [],
				children: [{ id: "one", label: "one", status: "done", sessionDir: "/tmp/one" }],
			},
		});
		const connected = ui.emit({ type: "connection_status", status: "connected" });
		await Promise.all([resync, connected]);
		const tray = stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
		expect(tray).toContain("1 inactive");
		expect(tray).toContain("0 running");
	});

	it("keeps roster preference for connected without a preceding gap", async () => {
		const ui = await createUi();
		ui.updateRoster(
			roster([
				["one", "running"],
				["two", "running"],
			]),
		);
		await ui.emit({
			type: "session_event",
			event: {
				type: "rlm_child_update",
				child: { id: "one", label: "one", status: "done", sessionDir: "/tmp/one" },
			},
		});
		await ui.emit({ type: "connection_status", status: "connected" });
		const tray = stripAnsi(ui.controls.subagentSummaryLine.render(120).join("\n"));
		expect(tray).toContain("2 running");
		expect(tray).toContain("0 inactive");
	});
});
