import type * as ChildProcessTypes from "../src/utils/child-process.js";
import type * as DaemonSupervisorOwnershipTypes from "../src/modes/daemon/daemon-supervisor-ownership.js";
import type * as SessionLeaseTypes from "../src/core/session-lease.js";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as DaemonUpdateRestartModule from "../src/cli/daemon-update-restart.js";
import {
	acquireDaemonUpdateRestartCoordinator,
	type DaemonUpdateRestartStatus,
	type DaemonUpdateRestartFailure,
	DaemonUpdateRestartStatusWriter,
	waitForActiveDaemonUpdateRestartCoordinator,
} from "../src/cli/daemon-update-restart.js";
import {
	ENV_AGENT_DIR,
	getDaemonUpdateRestartManifestPath,
	getLegacyDaemonUpdateRestartManifestPath,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../src/config.js";
import type { AgentSessionRuntimeMetadata } from "../src/core/agent-session-runtime.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";
import type * as DaemonSocketModule from "../src/modes/daemon/daemon-socket.js";
import * as processFacts from "../src/utils/child-process.js";
import * as retirement from "../src/cli/daemon-update-retirement.js";
import { getDaemonRuntimeIdentity } from "../src/modes/daemon/daemon-runtime-identity.js";
import { defaultWorkerDescriptorDir } from "../src/modes/daemon/daemon-worker-descriptors.js";
import { acquireDaemonShutdownAdmission, DaemonStartupFenceTimeoutError, waitForDaemonStartupFence } from "../src/modes/daemon/daemon-supervisor-ownership.js";
import {
	handlePackageCommand,
	prepareDaemonUpdateRestart,
	runDaemonUpdateRestartCoordinator,
} from "../src/package-manager-cli.js";

interface MockSessionSummary {
	id: string;
	activeSessionId?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning?: boolean;
	hasRunningRlmChildren?: boolean;
	sessionActions: { queuedCount: number; steering: string[]; followUps: string[] };
}

type MockRunningDaemonProbe = { reachable: false } | { reachable: true; activeSessions?: MockSessionSummary[] };

interface MockCustomMessage {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
	details?: unknown;
}

interface MockRecoveryAction {
	id: string;
	source: "internal";
	delivery: "next_turn_boundary" | "when_run_idle";
	wake: "immediate" | "on_lower_boundary" | "external_resume";
	queueKey?: string;
	snapshot?: unknown;
	agentMessageId?: string;
	payload: { kind: "turn" | "session_command"; text: string; [key: string]: unknown };
}

interface MockUpdateRestartSession {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	config: Record<string, unknown>;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
	queue: {
		actions: { formatVersion: 1; actions: MockRecoveryAction[] };
		nextTurn: MockCustomMessage[];
	};
	shouldResume: boolean;
	wasStreaming: boolean;
	wasCompacting: boolean;
	wasBashRunning: boolean;
	hadRunningRlmChildren: boolean;
	wasRetrying: boolean;
	hadAcceptedPromptInFlight: boolean;
}

interface MockUpdateRestartManifest {
	formatVersion: 1;
	createdAt: string;
	sessions: MockUpdateRestartSession[];
}

function createMockTurnExecutionPolicy(): Record<string, unknown> {
	return {
		preparation: {
			initialRefineBarrier: "skip",
			flushPendingBashBeforeValidation: false,
			validateModelAndAuth: true,
			awaitPendingModelSelection: true,
			preTurnCompaction: "beforeModelSelection",
			finalRefineBarrier: "always",
		},
		runBeforeAgentStart: true,
		nextTurnContextTiming: "commit",
		preserveEmptyExtensionPrompt: true,
		completionIncludesRetryChain: true,
	};
}

interface MockDaemonRequest {
	type: string;
	activeSessionId?: string;
	message?: string;
	agentMessageId?: string;
	customMessage?: MockCustomMessage;
	prefixMessages?: MockCustomMessage[];
	content?: unknown;
	messages?: MockCustomMessage[];
	queueKey?: string;
	snapshot?: unknown;
	sessionPath?: string;
	runtimeMetadata?: AgentSessionRuntimeMetadata;
}

type MockDaemonResponse = { success: true; data?: unknown } | { success: false; error: string };

afterEach(() => { vi.restoreAllMocks(); });

const mockState = vi.hoisted(() => ({
	calls: [] as string[],
	createActiveSessionIds: [] as string[],
	createThrowSessionPaths: [] as string[],
	daemonProbe: { reachable: true, activeSessions: [] } as MockRunningDaemonProbe,
	daemonProbeAfterShutdown: undefined as MockRunningDaemonProbe | undefined,
	globalPackageRoot: "",
	hello: { protocol: { version: 0 } } as {
		protocol: { version: number };
		schemaId?: string;
		supervisorGeneration?: string;
		supervisorOwnerToken?: string;
		supervisorPid?: number;
		supervisorProcessStartId?: string;
		supervisorSocketPath?: string;
		runtime?: ReturnType<typeof getDaemonRuntimeIdentity>;
	},
	helloCount: 0,
	lastCoordinatorStatus: undefined as DaemonUpdateRestartStatus | undefined,
	listResponse: undefined as MockDaemonResponse | undefined,
	noticeError: undefined as string | undefined,
	prepareError: undefined as string | undefined,
	prepareManifest: {
		formatVersion: 1,
		createdAt: "2026-07-07T00:00:00.000Z",
		sessions: [],
	} as MockUpdateRestartManifest,
	preparedManifestPath: "",
	prepareResponse: undefined as MockDaemonResponse | undefined,
	promptFailures: 0,
	probeSocketPaths: [] as string[],
	requestThrowTypes: [] as string[],
	disconnectRequestTypes: [] as string[],
	disconnectAfterPersistRequestTypes: [] as string[],
	requestPayloads: [] as MockDaemonRequest[],
	helloWaitFailures: 0,
	restoreActionFailures: 0,
	restoreNextTurnFailures: 0,
	socketPath: "",
	successorProcessStartId: "replacement-start" as string | undefined,
	successorSocketPath: undefined as string | undefined,
	spawnExitCodes: [] as number[],
	shutdownResult: true,
	shutdownAccepted: true,
	predecessorAlive: true,
	admissionActive: false,
	successorRuntime: undefined as ReturnType<typeof getDaemonRuntimeIdentity> | undefined,
}));

function useFixedOwnerHello(): void {
	mockState.hello = {
		protocol: { version: DAEMON_PROTOCOL_VERSION },
		schemaId: DAEMON_SCHEMA_ID,
		supervisorGeneration: "fixed-owner",
		supervisorOwnerToken: "owner-token",
		supervisorPid: 1001,
		supervisorProcessStartId: "process-start",
		supervisorSocketPath: mockState.socketPath,
	};
}

vi.mock("child_process", () => ({
	spawn: vi.fn((command: string, args: string[]) => {
		mockState.calls.push(`spawn:${command} ${args.join(" ")}`);
		const exitCode = mockState.spawnExitCodes.shift() ?? 0;
		const child = {
			on(event: string, listener: unknown) {
				if (event === "close") {
					queueMicrotask(() => {
						(listener as (code: number | null, signal: string | null) => void)(exitCode, null);
					});
				}
				return child;
			},
		};
		return child;
	}),
	spawnSync: vi.fn(() => ({
		status: 0,
		stdout: `${mockState.globalPackageRoot}\n`,
		stderr: "",
	})),
}));

vi.mock("../src/cli/daemon-update-restart.js", async (importOriginal) => {
	const original = await importOriginal<typeof DaemonUpdateRestartModule>();
	return {
		...original,
		launchDaemonUpdateRestartCoordinator: vi.fn(async (options: { socketPath: string }) => {
			mockState.calls.push(`launch-coordinator:${options.socketPath}`);
			return {
				version: 1,
				requestId: "test-request",
				socketPath: options.socketPath,
				phase: "complete",
				coordinator: { pid: process.pid },
				counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
		}),
	};
});

vi.mock("../src/modes/daemon/daemon-socket.js", async (importOriginal) => ({
	...(await importOriginal<typeof DaemonSocketModule>()),
	defaultDaemonSocketPath: () => mockState.socketPath,
}));

vi.mock("../src/modes/daemon/daemon-supervisor-ownership.js", async (original) => ({
	...await original<typeof DaemonSupervisorOwnershipTypes>(),
	acquireDaemonShutdownAdmission: vi.fn(async () => {
		mockState.calls.push("acquire-daemon-shutdown-admission");
		mockState.admissionActive = true;
		return {
			grantTargetTicket: vi.fn(async () => {
				expect(mockState.admissionActive).toBe(true); mockState.calls.push("grant-target-ticket"); return "target-ticket";
			}),
			assertTargetClaim: vi.fn(async () => {
				expect(mockState.admissionActive).toBe(true); mockState.calls.push("validate-target-claim");
			}),
			assertOrRenew: vi.fn(async () => {
				mockState.calls.push("renew-daemon-shutdown-admission");
			}),
			release: vi.fn(async () => {
				mockState.calls.push("release-daemon-shutdown-admission"); mockState.admissionActive = false;
			}),
		};
	}),
	persistDaemonStartupFenceFromOwner: vi.fn(async () => {
		mockState.calls.push("persist-daemon-startup-fence");
	}),
	waitForDaemonStartupFence: vi.fn(async () => {
		mockState.calls.push("wait-daemon-startup-fence");
	}),
}));

vi.mock("../src/core/session-lease.js", async (original) => ({
	...await original<typeof SessionLeaseTypes>(),
	getProcessStartId: (pid: number) => pid === mockState.hello.supervisorPid ? "process-start" : "replacement-start",
}));
vi.mock("../src/utils/child-process.js", async (original) => ({
	...await original<typeof ChildProcessTypes>(),
	isProcessAlive: vi.fn((pid: number) => pid !== 1001 || mockState.predecessorAlive),
}));

vi.mock("../src/cli/daemon-launch.js", () => ({
	canConnectToDaemon: vi.fn(async () => mockState.daemonProbe.reachable),
	ensureInteractiveDaemonRunning: vi.fn(async (_socket: string, _cwd: unknown, replacement: { admissionTicket: string }) => {
		expect(mockState.admissionActive).toBe(true); expect(replacement.admissionTicket).toBe("target-ticket");
		mockState.calls.push("ensure-daemon");
	}),
	isDaemonSessionSummary: (value: unknown) => {
		if (!value || typeof value !== "object") {
			return false;
		}
		const summary = value as { activeSessionId?: unknown; id?: unknown };
		return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
	},
	isSessionBusy: (summary: MockSessionSummary) =>
		summary.isStreaming ||
		summary.isCompacting ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true ||
		summary.sessionActions.queuedCount > 0,
	probeRunningDaemonSessions: vi.fn(async (socketPath: string) => {
		mockState.calls.push("probe-daemon");
		mockState.probeSocketPaths.push(socketPath);
		return mockState.daemonProbe;
	}),
	requestDaemonShutdownAndWait: vi.fn(async () => {
		mockState.calls.push("shutdown-daemon");
		if (mockState.daemonProbeAfterShutdown) {
			mockState.daemonProbe = mockState.daemonProbeAfterShutdown;
		}
		return { stopped: mockState.shutdownResult, shutdownAccepted: mockState.shutdownAccepted };
	}),
}));

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		private connected = false;
		private observedHello: typeof mockState.hello | undefined;

		constructor(readonly socketPath: string) {}

		get hello(): typeof mockState.hello | undefined {
			return this.observedHello;
		}

		async connect(): Promise<void> {
			mockState.calls.push(`daemon-connect:${this.socketPath}`);
			this.connected = true;
		}

		get isConnected(): boolean {
			return this.connected;
		}

		async waitForHello(): Promise<{
			protocol: { version: number };
			schemaId?: string;
			appVersion: string;
			supervisorGeneration?: string;
			supervisorOwnerToken?: string;
			supervisorPid?: number;
			supervisorProcessStartId?: string;
			supervisorSocketPath?: string;
			runtime?: ReturnType<typeof getDaemonRuntimeIdentity>;
		}> {
			if (mockState.helloWaitFailures > 0) {
				mockState.helloWaitFailures--;
				throw new Error("hello timed out");
			}
			const helloCount = mockState.helloCount++;
			const hello =
				helloCount === 0
					? {
							appVersion: VERSION,
							...mockState.hello,
						}
					: {
							protocol: { version: DAEMON_PROTOCOL_VERSION },
							schemaId: DAEMON_SCHEMA_ID,
							appVersion: VERSION,
							runtime: mockState.successorRuntime ?? getDaemonRuntimeIdentity(),
							supervisorPid: 1002,
							supervisorGeneration: "replacement-generation",
							supervisorOwnerToken: "replacement-owner-token",
							...(mockState.successorProcessStartId
								? { supervisorProcessStartId: mockState.successorProcessStartId }
								: {}),
							supervisorSocketPath: mockState.successorSocketPath ?? mockState.socketPath,
						};
			this.observedHello = hello;
			return hello;
		}

		async request(request: MockDaemonRequest): Promise<MockDaemonResponse> {
			this.observedHello ??= mockState.hello;
			mockState.calls.push(`daemon-request:${request.type}`);
			mockState.requestPayloads.push(request);
			if (mockState.disconnectRequestTypes.includes(request.type)) {
				this.connected = false;
				throw new Error(`${request.type} disconnected`);
			}
			if (mockState.requestThrowTypes.includes(request.type)) {
				throw new Error(`${request.type} failed`);
			}
			if (request.type === "append_custom_message" && mockState.noticeError) {
				throw new Error(mockState.noticeError);
			}
			if (request.type === "list" && mockState.listResponse) {
				return mockState.listResponse;
			}
			if (request.type === "prepare_update_restart") {
				if (mockState.prepareError) {
					return { success: false, error: mockState.prepareError };
				}
				const response = mockState.prepareResponse ?? { success: true, data: mockState.prepareManifest };
				if (response.success) {
					writeFileSync(mockState.preparedManifestPath, `${JSON.stringify(response.data)}\n`);
					if (mockState.disconnectAfterPersistRequestTypes.includes(request.type)) {
						this.connected = false;
						throw new Error(`${request.type} disconnected after persist`);
					}
				}
				return response;
			}
			if (request.type === "create") {
				if (request.sessionPath && mockState.createThrowSessionPaths.includes(request.sessionPath)) {
					throw new Error("create failed");
				}
				const activeSessionId = mockState.createActiveSessionIds.shift() ?? "restored-active";
				return { success: true, data: { id: activeSessionId, activeSessionId } };
			}
			if (request.type === "restore_actions" && mockState.restoreActionFailures > 0) {
				mockState.restoreActionFailures--;
				return { success: false, error: "restore failed" };
			}
			if (request.type === "restore_next_turn" && mockState.restoreNextTurnFailures > 0) {
				mockState.restoreNextTurnFailures--;
				return { success: false, error: "restore failed" };
			}
			if (request.type === "prompt" && mockState.promptFailures > 0) {
				mockState.promptFailures--;
				return { success: false, error: "prompt failed" };
			}
			return { success: true };
		}

		close(): void {
			this.connected = false;
		}
	},
}));

describe("self-update daemon restart", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalCwd: string;
	let originalExecPath: string;
	let originalExitCode: typeof process.exitCode;

	async function performUpdateAndRunCoordinator(originActiveSessionId?: string): Promise<void> {
		await handlePackageCommand(["update", "--self", "--daemon-socket", mockState.socketPath]);
		const restartDirectory = join(agentDir, "update-restarts");
		mkdirSync(restartDirectory, { recursive: true });
		mockState.lastCoordinatorStatus = await runDaemonUpdateRestartCoordinator({
			socketPath: mockState.socketPath,
			agentDir,
			statusPath: join(restartDirectory, "test-status.json"),
			originActiveSessionId,
		});
	}

	function createAcceptedRecoveryManifest(nextTurn: MockCustomMessage[] = []): MockUpdateRestartManifest {
		return {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: {
						actions: {
							formatVersion: 1,
							actions: [
								{
									id: "accepted-action",
									source: "internal",
									delivery: "when_run_idle",
									wake: "external_resume",
									agentMessageId: "agentmsg_accepted",
									payload: {
										kind: "turn",
										text: "accepted work",
										records: [
											{
												id: "accepted-action-primary",
												role: "primary",
												message: { role: "user", content: "accepted work", timestamp: 1 },
												ownerActionId: "accepted-action",
											},
										],
										executionPolicy: createMockTurnExecutionPolicy(),
										queueVisible: false,
										acceptedAgentMessage: false,
										acceptedBeforeCompletion: true,
									},
								},
							],
						},
						nextTurn,
					},
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
	}

	function writeBoundStatus(manifest: MockUpdateRestartManifest, failures: DaemonUpdateRestartFailure[], name = "previous-status.json") {
		mkdirSync(join(agentDir, "update-restarts"), { recursive: true });
		const writer = new DaemonUpdateRestartStatusWriter(join(agentDir, "update-restarts", name), "prior-run", mockState.socketPath);
		writer.update({ phase: "complete", manifestCreatedAt: manifest.createdAt,
			successor: { pid: mockState.hello.supervisorPid!, processStartId: mockState.hello.supervisorProcessStartId,
				supervisorGeneration: mockState.hello.supervisorGeneration, supervisorOwnerToken: mockState.hello.supervisorOwnerToken },
			counts: { total: manifest.sessions.length, restored: manifest.sessions.length - failures.length, resumed: 0, failed: failures.length }, failures });
		return writer;
	}

	beforeEach(() => {
		vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === 0) return true;
			throw new Error("test forbids real process signals");
		});
		tempDir = join(tmpdir(), `pi-self-update-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "global-prefix", "lib", "node_modules", PACKAGE_NAME);
		mockState.globalPackageRoot = join(tempDir, "global-prefix", "lib", "node_modules");
		mockState.hello = { protocol: { version: DAEMON_PROTOCOL_VERSION }, schemaId: DAEMON_SCHEMA_ID };
		mockState.helloCount = 0;
		mockState.lastCoordinatorStatus = undefined;
		mockState.listResponse = undefined;
		mockState.noticeError = undefined;
		mockState.prepareError = undefined;
		mockState.socketPath = join(tempDir, "daemon.sock");
		mockState.successorProcessStartId = "replacement-start";
		mockState.successorSocketPath = undefined;
		mockState.calls = [];
		mockState.createActiveSessionIds = [];
		mockState.createThrowSessionPaths = [];
		mockState.daemonProbe = { reachable: true, activeSessions: [] };
		mockState.daemonProbeAfterShutdown = undefined;
		mockState.disconnectAfterPersistRequestTypes = [];
		mockState.disconnectRequestTypes = [];
		mockState.prepareManifest = { formatVersion: 1, createdAt: "2026-07-07T00:00:00.000Z", sessions: [] };
		mockState.preparedManifestPath = getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir);
		mockState.prepareResponse = undefined;
		mockState.helloWaitFailures = 0;
		mockState.promptFailures = 0;
		mockState.probeSocketPaths = [];
		mockState.requestThrowTypes = [];
		mockState.requestPayloads = [];
		mockState.restoreActionFailures = 0;
		mockState.restoreNextTurnFailures = 0;
		mockState.spawnExitCodes = [];
		mockState.shutdownResult = true;
		mockState.shutdownAccepted = true;
		mockState.predecessorAlive = true;
		mockState.admissionActive = false;
		mockState.successorRuntime = undefined;
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(agentDir, "daemon-update-restarts"), { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.PI_PACKAGE_DIR;
		originalCwd = process.cwd();
		originalExecPath = process.execPath;
		originalExitCode = process.exitCode;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.PI_PACKAGE_DIR = packageDir;
		process.chdir(projectDir);
		Object.defineProperty(process, "execPath", {
			value: join(packageDir, "dist", "cli.js"),
			configurable: true,
		});
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ npmCommand: ["npm"] }, null, 2));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "999.0.0" })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
		if (originalPiPackageDir === undefined) {
			delete process.env.PI_PACKAGE_DIR;
		} else {
			process.env.PI_PACKAGE_DIR = originalPiPackageDir;
		}
		delete process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("scopes prepared restart manifests to the exact daemon socket", () => {
		const otherSocketPath = join(tempDir, "other-daemon.sock");

		expect(getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir)).not.toBe(
			getDaemonUpdateRestartManifestPath(otherSocketPath, agentDir),
		);
	});

	it.each([
		["unreadable", "{"],
		["unknown-format", JSON.stringify({ formatVersion: 0, createdAt: "stale", sessions: [] })],
	])("ignores a %s pending restart manifest when probing", async (_name, contents) => {
		writeFileSync(mockState.preparedManifestPath, contents);

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(
			mockState.prepareManifest,
		);
		expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
	});

	it("uses the interactive no-change sentinel only when self-update is unchanged", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ version: "0.2.6" })),
		);

		await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

		expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
	});

	it.each(["bad checksum", "duplicate platform"])(
		"keeps an up-to-date npm install and daemon untouched with %s metadata",
		async (invalidKind) => {
			process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
			const artifact = {
				platform: "linux-x64",
				file: `prime-agent-${VERSION}-linux-x64.tar.gz`,
				sha256: "a".repeat(64),
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({
						version: VERSION,
						package: PACKAGE_NAME,
						tarball: `https://releases.example/releases/v${VERSION}/prime-agent-${VERSION}.tgz`,
						binaries:
							invalidKind === "bad checksum" ? [{ ...artifact, sha256: "invalid" }] : [artifact, artifact],
					}),
				),
			);

			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE);
			expect(mockState.calls).toEqual([]);
		},
	);

	it.each(["bad checksum", "duplicate platform"])(
		"keeps the selected npm release URL when a newer release has %s metadata",
		async (invalidKind) => {
			mockState.daemonProbe = { reachable: false };
			const tarball = "https://releases.example/releases/v999.0.0/prime-agent-999.0.0.tgz";
			const artifact = {
				platform: "linux-x64",
				file: "prime-agent-999.0.0-linux-x64.tar.gz",
				sha256: "a".repeat(64),
			};
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json({
						version: "999.0.0",
						package: PACKAGE_NAME,
						tarball,
						binaries:
							invalidKind === "bad checksum" ? [{ ...artifact, sha256: "invalid" }] : [artifact, artifact],
					}),
				),
			);

			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(mockState.calls.filter((call) => call.startsWith("spawn:"))).toEqual([
				`spawn:npm install -g ${tarball}`,
			]);
		},
	);

	it("does not use the no-change sentinel when interactive self-update is cancelled", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		mockState.daemonProbe = {
			reachable: true,
			activeSessions: [
				{
					id: "busy",
					activeSessionId: "busy",
					isStreaming: true,
					isCompacting: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("does not prepare or stop the daemon when the package update fails", async () => {
		mockState.spawnExitCodes = [23];
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(handlePackageCommand(["update", "--self"])).resolves.toBe(true);

			expect(process.exitCode).toBe(1);
			expect(mockState.calls).toContain("probe-daemon");
			expect(mockState.calls.some((call) => call === "daemon-request:prepare_update_restart")).toBe(false);
			expect(mockState.calls.some((call) => call === "shutdown-daemon")).toBe(false);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("defers the exact custom-socket restart to the interactive parent", async () => {
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
		const customSocketPath = join(tempDir, "custom", "daemon.sock");

		await expect(handlePackageCommand(["update", "--self", "--daemon-socket", customSocketPath])).resolves.toBe(true);

		expect(mockState.probeSocketPaths).toEqual([customSocketPath]);
		expect(mockState.calls.some((call) => call.startsWith("spawn:npm "))).toBe(true);
		expect(mockState.calls.some((call) => call.startsWith("launch-coordinator:"))).toBe(false);
	});

	it("serializes coordinators per exact socket", async () => {
		const registryDir = join(tempDir, "restart-registry");
		const first = await acquireDaemonUpdateRestartCoordinator({
			requestId: "first",
			socketPath: mockState.socketPath,
			statusPath: join(agentDir, "first.json"),
			registryDir,
		});
		try {
			await expect(
				acquireDaemonUpdateRestartCoordinator({
					requestId: "second",
					socketPath: mockState.socketPath,
					statusPath: join(agentDir, "second.json"),
					registryDir,
				}),
			).rejects.toThrow("already running");
		} finally {
			await first.release();
		}
	});

	it("waits for the active coordinator before a concurrent loser completes", async () => {
		const activeStatusPath = join(agentDir, "active-status.json");
		const activeStatus = new DaemonUpdateRestartStatusWriter(
			activeStatusPath,
			"active-request",
			mockState.socketPath,
		);
		activeStatus.update({ phase: "preparing" });
		const activeLease = await acquireDaemonUpdateRestartCoordinator({
			requestId: "active-request",
			socketPath: mockState.socketPath,
			statusPath: activeStatusPath,
		});
		let settled = false;
		try {
			const loser = runDaemonUpdateRestartCoordinator({
				socketPath: mockState.socketPath,
				agentDir,
				statusPath: join(agentDir, "loser-status.json"),
			}).finally(() => {
				settled = true;
			});

			await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
			expect(settled).toBe(false);
			activeStatus.update({
				phase: "complete",
				counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
				message: "active coordinator completed",
			});

			await expect(loser).resolves.toMatchObject({
				phase: "complete",
				counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
				message: expect.stringContaining("active coordinator completed"),
			});
			expect(mockState.calls).not.toContain("probe-daemon");
		} finally {
			await activeLease.release();
		}
	});

	it("returns a terminal status written immediately before coordinator exit", async () => {
		const statusPath = join(agentDir, "exit-race-status.json");
		const statusWriter = new DaemonUpdateRestartStatusWriter(statusPath, "exit-race", mockState.socketPath);
		statusWriter.update({ phase: "preparing" });
		const killSpy = vi.spyOn(processFacts, "isProcessAlive").mockImplementation(() => {
			statusWriter.update({ phase: "complete" });
			return false;
		});

		try {
			await expect(
				waitForActiveDaemonUpdateRestartCoordinator({
					version: 1,
					token: "exit-race-token",
					requestId: "exit-race",
					pid: 999_999,
					socketPath: mockState.socketPath,
					statusPath,
					createdAt: new Date().toISOString(),
				}),
			).resolves.toMatchObject({ phase: "complete" });
		} finally {
			killSpy.mockRestore();
		}
	});

	it("rejects a successor that answers for another socket", async () => {
		mockState.successorSocketPath = join(tempDir, "wrong-daemon.sock");

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "failed",
			message: expect.stringContaining("does not match"),
		});
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
	});

	it("accepts a fixed replacement owner when process start ids are unavailable", async () => {
		mockState.hello = {
			protocol: { version: 2 },
			supervisorGeneration: "predecessor-generation",
			supervisorOwnerToken: "predecessor-owner-token",
			supervisorPid: 1001,
			supervisorSocketPath: mockState.socketPath,
		};
		mockState.successorProcessStartId = undefined;

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			successor: {
				pid: 1002,
				supervisorGeneration: "replacement-generation",
				supervisorOwnerToken: "replacement-owner-token",
			},
		});
	});

	it("retains the prepared manifest and never restores into a predecessor that refuses shutdown", async () => {
		mockState.shutdownResult = false;
		mockState.shutdownAccepted = false;
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "failed",
			counts: { total: 1, restored: 0, resumed: 0, failed: 0 },
		});
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
	});

	it("starts a successor when shutdown identity confirmation times out after the socket is gone", async () => {
		mockState.shutdownResult = false;
		mockState.daemonProbeAfterShutdown = { reachable: false };
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
		});
		expect(mockState.calls).toContain("ensure-daemon");
		expect(existsSync(mockState.preparedManifestPath)).toBe(false);
	});

	it("continues queued-work restoration when the update notice request rejects", async () => {
		mockState.noticeError = "socket closed";
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: {},
					queue: {
						actions: { formatVersion: 1, actions: [] },
						nextTurn: [
							{
								role: "custom",
								customType: "queued-context",
								content: "preserve me",
								display: false,
								timestamp: 1,
							},
						],
					},
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await performUpdateAndRunCoordinator("old-active");

			expect(mockState.lastCoordinatorStatus).toMatchObject({
				phase: "complete",
				counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
			});
			expect(mockState.requestPayloads.map((request) => request.type)).toContain("restore_next_turn");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("restarts the daemon only after the package update succeeds", async () => {
		useFixedOwnerHello();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			const spawnIndex = mockState.calls.findIndex((call) => call.startsWith("spawn:npm "));
			const launchIndex = mockState.calls.indexOf(`launch-coordinator:${mockState.socketPath}`);
			const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
			const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
			const admissionIndex = mockState.calls.indexOf("acquire-daemon-shutdown-admission");
			const shutdownIndex = mockState.calls.indexOf("shutdown-daemon");
			const startupFenceIndex = mockState.calls.indexOf("wait-daemon-startup-fence");
			const releaseAdmissionIndex = mockState.calls.indexOf("release-daemon-shutdown-admission");
			const ensureIndex = mockState.calls.indexOf("ensure-daemon");
			expect(spawnIndex).toBeGreaterThanOrEqual(0);
			expect(launchIndex).toBeGreaterThan(spawnIndex);
			expect(admissionIndex).toBeGreaterThan(launchIndex);
			expect(prepareIndex).toBeGreaterThan(admissionIndex);
			expect(fenceIndex).toBeGreaterThan(prepareIndex);
			expect(shutdownIndex).toBeGreaterThan(fenceIndex);
			expect(startupFenceIndex).toBeGreaterThan(shutdownIndex);
			expect(releaseAdmissionIndex).toBeGreaterThan(startupFenceIndex);
			expect(ensureIndex).toBeLessThan(releaseAdmissionIndex);
			expect(mockState.calls.indexOf("grant-target-ticket")).toBeLessThan(ensureIndex);
			expect(mockState.calls.indexOf("validate-target-claim")).toBeLessThan(releaseAdmissionIndex);
			expect(ensureIndex).toBeGreaterThan(shutdownIndex);
			expect(statSync(join(agentDir, "update-restarts", "test-status.json")).mode & 0o777).toBe(0o600);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not persist a predecessor fence when restart preparation fails", async () => {
		useFixedOwnerHello();

		for (const prepareResponse of [
			{ success: false, error: "prepare failed" } as const,
			{
				success: true,
				data: { formatVersion: 1, createdAt: "2026-07-07T00:00:00.000Z", sessions: "invalid" },
			} as const,
		]) {
			mockState.calls = [];
			mockState.prepareResponse = prepareResponse;
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow();
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
		}
	});

	it("persists a fixed predecessor fence when the hello arrives after the initial probe", async () => {
		useFixedOwnerHello();
		mockState.helloWaitFailures = 1;

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(
			mockState.prepareManifest,
		);

		const prepareIndex = mockState.calls.indexOf("daemon-request:prepare_update_restart");
		const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
		expect(prepareIndex).toBeGreaterThanOrEqual(0);
		expect(fenceIndex).toBeGreaterThan(prepareIndex);
	});

	it("recovers a retained legacy manifest only when the exact predecessor is confirmed dead", async () => {
		useFixedOwnerHello();
		mockState.predecessorAlive = false;
		const legacyManifestPath = getLegacyDaemonUpdateRestartManifestPath(agentDir);
		mockState.preparedManifestPath = legacyManifestPath;
		mockState.disconnectAfterPersistRequestTypes = ["prepare_update_restart"];
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-id",
					sessionFile: join(tempDir, "session.jsonl"),
					cwd: tempDir,
					config: { apiKey: "legacy-secret" },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};

		await performUpdateAndRunCoordinator();

		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete",
			counts: { total: 1, restored: 1, resumed: 0, failed: 0 },
		});
		expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
		expect(existsSync(legacyManifestPath)).toBe(false);
		expect(existsSync(getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir))).toBe(false);
	});

	it("fences a pending prepared restart only after verifying the live daemon is empty", async () => {
		useFixedOwnerHello();
		const pendingManifest: MockUpdateRestartManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "pending-active",
					sessionId: "pending-session",
					sessionFile: join(projectDir, "pending.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		writeFileSync(
			getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir),
			JSON.stringify(pendingManifest),
		);
		mockState.requestThrowTypes = ["list"];

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow("list failed");
		expect(mockState.calls).not.toContain("persist-daemon-startup-fence");

		mockState.calls = [];
		mockState.requestThrowTypes = [];
		mockState.listResponse = { success: true, data: { sessions: [], busyClientOwnedSessionCount: 0 } };
		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).resolves.toEqual(pendingManifest);
		const listIndex = mockState.calls.indexOf("daemon-request:list");
		const fenceIndex = mockState.calls.indexOf("persist-daemon-startup-fence");
		expect(listIndex).toBeGreaterThanOrEqual(0);
		expect(fenceIndex).toBeGreaterThan(listIndex);
		expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");

		mockState.calls = [];
		mockState.listResponse = {
			success: true,
			data: {
				sessions: [
					{
						id: "live-active",
						isStreaming: false,
						isCompacting: false,
						sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					},
				],
			},
		};
		mockState.disconnectRequestTypes = ["prepare_update_restart"];
		writeFileSync(
			getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir),
			JSON.stringify(pendingManifest),
		);

		await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow(
			"prepare_update_restart disconnected",
		);
		expect(existsSync(getDaemonUpdateRestartManifestPath(mockState.socketPath, agentDir))).toBe(true);
	});

	it("skips predecessor fencing when the daemon hello has no fixed-owner identity", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(mockState.calls).not.toContain("persist-daemon-startup-fence");
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("still resumes accepted prompts when accepted context restore fails", async () => {
		mockState.restoreActionFailures = 1;
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator("old-active")).resolves.toBeUndefined();

			expect(mockState.requestPayloads.some((request) => request.type === "restore_actions")).toBe(true);
			expect(mockState.requestPayloads.some((request) => request.type === "prompt")).toBe(true);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("does not replay a continuation after restoring an accepted turn", async () => {
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator("old-active")).resolves.toBeUndefined();

			expect(mockState.requestPayloads.filter((request) => request.type === "restore_actions")).toHaveLength(1);
			expect(mockState.requestPayloads.some((request) => request.type === "prompt")).toBe(false);
			expect(mockState.requestPayloads.filter((request) => request.type === "resume_queue")).toHaveLength(1);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("continues restoring later sessions when one session restore throws", async () => {
		const failedSessionFile = join(projectDir, "failed.jsonl");
		const restoredSessionFile = join(projectDir, "restored.jsonl");
		mockState.createThrowSessionPaths = [failedSessionFile];
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "failed-active",
					sessionId: "failed-session",
					sessionFile: failedSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "restored-active",
					sessionId: "restored-session",
					sessionFile: restoredSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: true,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			expect(
				mockState.requestPayloads
					.filter((request) => request.type === "create")
					.map((request) => request.sessionPath),
			).toEqual([failedSessionFile, restoredSessionFile]);
			expect(
				mockState.requestPayloads.some(
					(request) => request.type === "prompt" && request.activeSessionId === "restored-active",
				),
			).toBe(true);
			expect(mockState.lastCoordinatorStatus?.counts).toEqual({
				total: 2,
				restored: 1,
				resumed: 1,
				failed: 1,
			});
			expect(mockState.lastCoordinatorStatus?.failures).toEqual([
				{ sessionFile: failedSessionFile, message: "create failed", kind: "create_failed" },
			]);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("restores subagent runtime metadata under the recreated parent session", async () => {
		const parentSessionFile = join(projectDir, "parent.jsonl");
		const childSessionFile = join(projectDir, "child.jsonl");
		mockState.createActiveSessionIds = ["new-parent", "new-child"];
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-parent",
					sessionId: "parent-session",
					sessionFile: parentSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: { kind: "top-level", createdAt: 1 },
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
				{
					activeSessionId: "old-child",
					sessionId: "child-session",
					sessionFile: childSessionFile,
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					runtimeMetadata: {
						kind: "subagent",
						createdAt: 2,
						parentActiveSessionId: "old-parent",
						parentSessionId: "parent-session",
						parentSessionFile,
						rlmChildId: "child-1",
						prompt: "child task",
					},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();

			const createRequests = mockState.requestPayloads.filter((request) => request.type === "create");
			expect(createRequests).toHaveLength(2);
			expect(createRequests[0]).toMatchObject({
				sessionPath: parentSessionFile,
				runtimeMetadata: { kind: "top-level", createdAt: 1 },
			});
			expect(createRequests[1]).toMatchObject({
				sessionPath: childSessionFile,
				runtimeMetadata: {
					kind: "subagent",
					createdAt: 2,
					parentActiveSessionId: "new-parent",
					parentSessionId: "parent-session",
					parentSessionFile,
					rlmChildId: "child-1",
					prompt: "child task",
				},
			});
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("rejects malformed recovery actions while parsing the manifest", async () => {
		const manifest = createAcceptedRecoveryManifest();
		const session = manifest.sessions[0]!;
		const action = session.queue.actions.actions[0]!;
		const incompleteExecutionPolicy = createMockTurnExecutionPolicy();
		delete incompleteExecutionPolicy.nextTurnContextTiming;
		const cases: { name: string; action: MockRecoveryAction }[] = [
			{
				name: "turn without primary record",
				action: { ...action, payload: { ...action.payload, records: [] } },
			},
			{
				name: "non-array images",
				action: { ...action, payload: { ...action.payload, images: {} } },
			},
			{
				name: "turn execution policy missing next-turn context timing",
				action: {
					...action,
					payload: { ...action.payload, executionPolicy: incompleteExecutionPolicy },
				},
			},
			{
				name: "unknown session command",
				action: {
					...action,
					payload: {
						kind: "session_command",
						text: "/bogus",
						command: { name: "bogus", args: "", text: "/bogus" },
					},
				},
			},
		];

		for (const testCase of cases) {
			mockState.prepareResponse = {
				success: true,
				data: {
					...manifest,
					sessions: [
						{
							...session,
							queue: { ...session.queue, actions: { formatVersion: 1, actions: [testCase.action] } },
						},
					],
				},
			};
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir), testCase.name).rejects.toThrow(
				"Daemon update restart response is missing session actions",
			);
		}
	});

	it("preserves complete queued actions and rejects unknown recovery formats", async () => {
		const customMessage: MockCustomMessage = {
			role: "custom",
			customType: "heartbeat_prompt",
			content: "heartbeat body",
			display: true,
			timestamp: Date.now(),
		};
		const recoveredAction: MockRecoveryAction = {
			id: "action-1",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_followup",
			payload: {
				kind: "turn",
				text: "heartbeat body",
				customMessage,
				records: [
					{
						id: "action-1-primary",
						role: "primary",
						message: customMessage,
						ownerActionId: "action-1",
					},
				],
				executionPolicy: createMockTurnExecutionPolicy(),
				queueVisible: true,
				acceptedAgentMessage: false,
				acceptedBeforeCompletion: false,
			},
		};
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [recoveredAction] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();
			expect(mockState.requestPayloads).toContainEqual({
				type: "restore_actions",
				activeSessionId: "restored-active",
				snapshot: { formatVersion: 1, actions: [recoveredAction] },
			});
			mockState.prepareResponse = {
				success: true,
				data: { ...mockState.prepareManifest, formatVersion: 2 },
			};
			await expect(prepareDaemonUpdateRestart(mockState.socketPath, agentDir)).rejects.toThrow(
				"Unsupported daemon update restart format version: 2",
			);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});

	it("resumes restored queued work when continuation replay fails", async () => {
		mockState.promptFailures = 1;
		const recoveredAction: MockRecoveryAction = {
			id: "action-queued",
			source: "internal",
			delivery: "when_run_idle",
			wake: "external_resume",
			agentMessageId: "agentmsg_followup",
			payload: {
				kind: "turn",
				text: "queued follow-up",
				records: [
					{
						id: "action-queued-primary",
						role: "primary",
						message: { role: "user", content: "queued follow-up", timestamp: 1 },
						ownerActionId: "action-queued",
					},
				],
				executionPolicy: createMockTurnExecutionPolicy(),
				queueVisible: true,
				acceptedAgentMessage: false,
				acceptedBeforeCompletion: false,
			},
		};
		mockState.prepareManifest = {
			formatVersion: 1,
			createdAt: "2026-07-07T00:00:00.000Z",
			sessions: [
				{
					activeSessionId: "old-active",
					sessionId: "session-1",
					sessionFile: join(projectDir, "session.jsonl"),
					cwd: projectDir,
					config: { cwd: projectDir, agentDir },
					queue: { actions: { formatVersion: 1, actions: [recoveredAction] }, nextTurn: [] },
					shouldResume: true,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: true,
				},
			],
		};
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(performUpdateAndRunCoordinator()).resolves.toBeUndefined();
			expect(mockState.requestPayloads.some((request) => request.type === "restore_actions")).toBe(true);
			expect(mockState.requestPayloads.some((request) => request.type === "resume_queue")).toBe(true);
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
	it("retains a recent manifest when PREPARE disconnects but the predecessor is still alive", async () => {
		useFixedOwnerHello(); mockState.disconnectAfterPersistRequestTypes = ["prepare_update_restart"];
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed" });
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
		expect(mockState.calls).not.toContain("ensure-daemon");
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
	});

	it.each(["dead", "survived_sigkill"] as const)("keeps the supervisor fence contract when escalation returns %s", async (outcome) => {
		useFixedOwnerHello(); mockState.shutdownResult = false; mockState.daemonProbeAfterShutdown = { reachable: false };
		vi.mocked(waitForDaemonStartupFence).mockRejectedValueOnce(new DaemonStartupFenceTimeoutError({
			pid: 1001, processStartId: "process-start", ownerToken: "owner-token", supervisorGeneration: "fixed-owner", socketPath: mockState.socketPath,
		}));
		const escalation = vi.spyOn(retirement, "escalateExactProcess").mockImplementation(async (identity, options) => {
			const report = { pid: identity.pid, processStartId: identity.processStartId, signals: ["SIGTERM", "SIGKILL"], outcome, at: new Date().toISOString() };
			options?.onProgress?.(report); return report;
		});
		await performUpdateAndRunCoordinator();
		expect(escalation).toHaveBeenCalledTimes(1);
		if (outcome === "dead") expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "complete", escalation: { outcome: "dead" } });
		else {
			expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", message: expect.stringContaining("blocked: predecessor 1001 survived SIGKILL") });
			expect(mockState.calls).not.toContain("ensure-daemon"); expect(existsSync(mockState.preparedManifestPath)).toBe(true);
		}
	});

	it("does not signal a predecessor that is still listening at the fence deadline", async () => {
		useFixedOwnerHello(); mockState.shutdownResult = false;
		vi.mocked(waitForDaemonStartupFence).mockRejectedValueOnce(new DaemonStartupFenceTimeoutError({
			pid: 1001, processStartId: "process-start", ownerToken: "owner-token", supervisorGeneration: "fixed-owner", socketPath: mockState.socketPath,
		}));
		const escalation = vi.spyOn(retirement, "escalateExactProcess").mockRejectedValue(new Error("test forbids real process signals"));
		await performUpdateAndRunCoordinator();
		expect(escalation).not.toHaveBeenCalled(); expect(mockState.calls).not.toContain("ensure-daemon");
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", message: expect.stringContaining("G3") });
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it("keeps the manifest when a validated successor has a partial restore failure", async () => {
		mockState.prepareManifest = createAcceptedRecoveryManifest(); mockState.restoreActionFailures = 1;
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus?.counts.failed).toBe(1);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it("skips an already-active exact target without preparing another cutover", async () => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "skipped" });
		expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");
		expect(mockState.calls).not.toContain("shutdown-daemon");
		expect(mockState.calls).not.toContain("ensure-daemon");
	});

	it("continues only missing sessions and keeps the remapped parent on an idempotent retry", async () => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		const template = createAcceptedRecoveryManifest().sessions[0]!;
		const sessions = ["parent", "other", "child"].map((name) => ({ ...template, activeSessionId: `old-${name}`,
			sessionId: name, sessionFile: join(projectDir, `${name}.jsonl`), shouldResume: false,
			queue: { actions: { formatVersion: 1 as const, actions: [] }, nextTurn: [] } }));
		sessions[2]!.runtimeMetadata = { kind: "subagent", createdAt: 1, parentActiveSessionId: "old-parent", parentSessionId: "parent", parentSessionFile: sessions[0]!.sessionFile, rlmChildId: "child" };
		mockState.prepareManifest = { formatVersion: 1, createdAt: new Date().toISOString(), sessions };
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		writeBoundStatus(mockState.prepareManifest, [{ sessionFile: sessions[2]!.sessionFile, kind: "create_failed", message: "create failed" }], "test-status.json");
		mockState.listResponse = { success: true, data: { sessions: sessions.slice(0, 1).map((session) => ({ sessionFile: session.sessionFile, activeSessionId: `new-${session.sessionId}`, workerState: "ready" })) } };
		// The other previously resolved session was closed by the user. It must stay closed.
		await performUpdateAndRunCoordinator();
		expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");
		const creates = mockState.requestPayloads.filter((request) => request.type === "create");
		expect(creates).toHaveLength(1);
		expect(creates[0]).toMatchObject({ sessionPath: sessions[2]!.sessionFile, runtimeMetadata: { parentActiveSessionId: "new-parent" } });
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "complete", counts: { total: 3, restored: 3, failed: 0 } });
		expect(existsSync(mockState.preparedManifestPath)).toBe(false);
	});

	it.each(["build", "slot"] as const)("retains the manifest and sends no restore command to a wrong %s successor", async (mismatch) => {
		const runtime = getDaemonRuntimeIdentity();
		const foreignEntry = join(tempDir, "foreign-entry.js"); writeFileSync(foreignEntry, "// foreign slot");
		mockState.successorRuntime = mismatch === "build" ? { ...runtime, buildId: "foreign-build" } : { ...runtime, entrypointPath: foreignEntry };
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", message: expect.stringContaining("expected build") });
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it("permits a deliberate same-target restart only with explicit intent", async () => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		const previous = process.env.PRIME_AGENT_UPDATE_RESTART_ALLOW_SAME_BUILD;
		process.env.PRIME_AGENT_UPDATE_RESTART_ALLOW_SAME_BUILD = "1";
		try {
			await performUpdateAndRunCoordinator();
			expect(mockState.calls).toContain("daemon-request:prepare_update_restart");
			expect(mockState.calls).toContain("ensure-daemon");
		} finally {
			if (previous === undefined) delete process.env.PRIME_AGENT_UPDATE_RESTART_ALLOW_SAME_BUILD;
			else process.env.PRIME_AGENT_UPDATE_RESTART_ALLOW_SAME_BUILD = previous;
		}
	});

	it.each([true, false])("recognizes a prior held worker only when its manifest binding matches (%s)", async (matches) => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		mockState.daemonProbe = { reachable: false };
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		const directory = defaultWorkerDescriptorDir(agentDir, mockState.socketPath); mkdirSync(directory, { recursive: true });
		const rootId = mockState.prepareManifest.sessions[0]!.activeSessionId;
		writeFileSync(join(directory, "held.json"), JSON.stringify({ version: 2, workerId: "held", pid: 1337,
			processStartId: "replacement-start", supervisorSocketPath: mockState.socketPath, socketPath: join(tempDir, "worker.sock"),
			authenticationToken: "private", rootActiveSessionId: rootId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			consecutiveFailures: 0, lifecycle: "recovering", createCommand: { type: "create" },
			updateRestartRecoveryHold: { reason: "update_restart_recovery_uncertain", pid: 1337, processStartId: "replacement-start",
				rootActiveSessionId: rootId, activeSessionIds: [rootId], createdAt: new Date().toISOString(),
				manifestCreatedAt: matches ? mockState.prepareManifest.createdAt : "2000-01-01T00:00:00.000Z" } }));
		await performUpdateAndRunCoordinator();
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
		if (matches) expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "complete", counts: { failed: 1 } });
		else {
			expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", message: expect.stringContaining("no successful PREPARE inventory") });
			expect(mockState.calls).not.toContain("ensure-daemon");
		}
	});

	it("refuses an unbound already-active continuation and keeps its checkpoint", async () => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", message: expect.stringContaining("not bound") });
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it("does not automatically replay a degraded checkpoint even after its session was closed", async () => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		writeBoundStatus(mockState.prepareManifest, [{ sessionFile: mockState.prepareManifest.sessions[0]!.sessionFile, kind: "degraded", message: "action restore failed after activation" }]);
		mockState.listResponse = { success: true, data: { sessions: [] } };
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "complete", counts: { failed: 1 }, failures: [{ kind: "degraded" }] });
		expect(mockState.requestPayloads.some((request) => request.type === "create" || request.type === "prompt" || request.type === "resume_queue")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it("leaves every resolved-then-closed session closed on a bound retry", async () => {
		useFixedOwnerHello(); mockState.hello.runtime = getDaemonRuntimeIdentity();
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		writeBoundStatus(mockState.prepareManifest, [], "test-status.json");
		mockState.listResponse = { success: true, data: { sessions: [] } };
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "complete", counts: { restored: 1, failed: 0 } });
		expect(mockState.requestPayloads.some((request) => request.type === "create" || request.type === "prompt")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(false);
	});

	it("records a strict target-claim failure as never-started restores for an immediate bound retry", async () => {
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		const acquire = vi.mocked(acquireDaemonShutdownAdmission);
		acquire.mockImplementationOnce(async () => ({
			assertOrRenew: async () => {}, release: async () => {}, grantTargetTicket: async () => "target-ticket",
			assertTargetClaim: async () => { throw new Error("Replacement daemon did not claim the target admission ticket"); },
		} as unknown as Awaited<ReturnType<typeof acquireDaemonShutdownAdmission>>));
		mockState.admissionActive = true;
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", counts: { restored: 0, failed: 1 },
			failures: [{ kind: "create_failed", message: "Restore was not started" }] });
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it.each(["idle", "predecessor-dead", "no-daemon"] as const)("suppresses resolved checkpoints through the %s pending reuse route", async (route) => {
		useFixedOwnerHello();
		const template = createAcceptedRecoveryManifest().sessions[0]!;
		const sessions = ["resolved", "failed"].map((name) => ({ ...template, activeSessionId: `old-${name}`, sessionId: name, sessionFile: join(projectDir, `${name}.jsonl`) }));
		mockState.prepareManifest = { formatVersion: 1, createdAt: new Date().toISOString(), sessions };
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		writeBoundStatus(mockState.prepareManifest, [{ sessionFile: sessions[1]!.sessionFile, kind: "create_failed", message: "create failed" }]);
		mockState.hello.runtime = { ...getDaemonRuntimeIdentity(), buildId: "previous-build" };
		mockState.listResponse = { success: true, data: { sessions: [], busyClientOwnedSessionCount: 0 } };
		if (route === "predecessor-dead") {
			mockState.listResponse = { success: true, data: { sessions: [{ id: "preparing" }], busyClientOwnedSessionCount: 0 } };
			mockState.requestThrowTypes = ["prepare_update_restart"]; mockState.predecessorAlive = false;
			mockState.daemonProbeAfterShutdown = { reachable: false };
		}
		if (route === "no-daemon") {
			mockState.daemonProbe = { reachable: false };
			mockState.hello = { ...mockState.hello, supervisorPid: 2001, supervisorGeneration: "new-owner", supervisorOwnerToken: "new-token", runtime: getDaemonRuntimeIdentity() };
		}
		mockState.createActiveSessionIds = ["restored-failed"];
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "complete", counts: { total: 2, restored: 2, failed: 0 } });
		expect(mockState.requestPayloads.filter((request) => request.type === "create").map((request) => request.sessionPath)).toEqual([sessions[1]!.sessionFile]);
		expect(mockState.requestPayloads.filter((request) => request.type === "prompt" || request.type === "resume_queue").every((request) => request.activeSessionId === "restored-failed")).toBe(true);
		if (route !== "predecessor-dead") expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");
	});

	it.each(["idle", "predecessor-dead", "no-daemon"] as const)("refuses incomplete restoration history through the %s pending reuse route", async (route) => {
		useFixedOwnerHello();
		const template = createAcceptedRecoveryManifest().sessions[0]!;
		const sessions = ["resolved", "uncertain"].map((name) => ({ ...template, activeSessionId: name, sessionId: name, sessionFile: join(projectDir, `${name}.jsonl`) }));
		mockState.prepareManifest = { formatVersion: 1, createdAt: new Date().toISOString(), sessions };
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		const prior = writeBoundStatus(mockState.prepareManifest, []);
		prior.update({ phase: "restoring", counts: { total: 2, restored: 1, resumed: 0, failed: 0 } });
		mockState.hello.runtime = { ...getDaemonRuntimeIdentity(), buildId: "previous-build" };
		mockState.listResponse = { success: true, data: { sessions: [], busyClientOwnedSessionCount: 0 } };
		if (route === "predecessor-dead") {
			mockState.listResponse = { success: true, data: { sessions: [{ id: "preparing" }], busyClientOwnedSessionCount: 0 } };
			mockState.requestThrowTypes = ["prepare_update_restart"]; mockState.predecessorAlive = false;
		}
		if (route === "no-daemon") mockState.daemonProbe = { reachable: false };
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", message: expect.stringContaining("incomplete per-session") });
		expect(mockState.calls).not.toContain("ensure-daemon");
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

	it("does not reclassify resolved checkpoints after a claim failure on a pending retry", async () => {
		useFixedOwnerHello();
		const template = createAcceptedRecoveryManifest().sessions[0]!;
		const sessions = ["resolved", "failed"].map((name) => ({ ...template, activeSessionId: name, sessionId: name, sessionFile: join(projectDir, `${name}.jsonl`) }));
		mockState.prepareManifest = { formatVersion: 1, createdAt: new Date().toISOString(), sessions };
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		writeBoundStatus(mockState.prepareManifest, [{ sessionFile: sessions[1]!.sessionFile, kind: "create_failed", message: "create failed" }]);
		mockState.hello.runtime = { ...getDaemonRuntimeIdentity(), buildId: "previous-build" };
		mockState.listResponse = { success: true, data: { sessions: [], busyClientOwnedSessionCount: 0 } };
		vi.mocked(acquireDaemonShutdownAdmission).mockImplementationOnce(async () => ({
			assertOrRenew: async () => {}, release: async () => {}, grantTargetTicket: async () => "target-ticket",
			assertTargetClaim: async () => { throw new Error("target claim missing"); },
		} as unknown as Awaited<ReturnType<typeof acquireDaemonShutdownAdmission>>));
		mockState.admissionActive = true;
		await performUpdateAndRunCoordinator();
		expect(mockState.lastCoordinatorStatus).toMatchObject({ phase: "failed", counts: { total: 2, restored: 1, failed: 1 },
			failures: [{ sessionFile: sessions[1]!.sessionFile, kind: "create_failed" }] });
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
	});

	it("carries a manifest-bound live worker hold through idle-daemon reuse without dispatching create", async () => {
		useFixedOwnerHello();
		mockState.hello.runtime = { ...getDaemonRuntimeIdentity(), buildId: "previous-build" };
		mockState.prepareManifest = createAcceptedRecoveryManifest();
		writeFileSync(mockState.preparedManifestPath, JSON.stringify(mockState.prepareManifest));
		mockState.listResponse = { success: true, data: { sessions: [], busyClientOwnedSessionCount: 0 } };
		const directory = defaultWorkerDescriptorDir(agentDir, mockState.socketPath);
		mkdirSync(directory, { recursive: true });
		const rootId = mockState.prepareManifest.sessions[0]!.activeSessionId;
		writeFileSync(join(directory, "idle-held.json"), JSON.stringify({
			version: 2, workerId: "idle-held", pid: 1337, processStartId: "replacement-start",
			supervisorSocketPath: mockState.socketPath, socketPath: join(tempDir, "held-worker.sock"),
			authenticationToken: "private", rootActiveSessionId: rootId,
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			consecutiveFailures: 0, lifecycle: "recovering", createCommand: { type: "create" },
			updateRestartRecoveryHold: {
				reason: "update_restart_recovery_uncertain", pid: 1337, processStartId: "replacement-start",
				rootActiveSessionId: rootId, activeSessionIds: [rootId], createdAt: new Date().toISOString(),
				manifestCreatedAt: mockState.prepareManifest.createdAt,
			},
		}));
		await performUpdateAndRunCoordinator();
		expect(mockState.calls).not.toContain("daemon-request:prepare_update_restart");
		expect(mockState.calls).toContain("ensure-daemon");
		expect(mockState.requestPayloads.some((request) => request.type === "create")).toBe(false);
		expect(mockState.lastCoordinatorStatus).toMatchObject({
			phase: "complete", counts: { total: 1, restored: 0, failed: 1 }, failures: [{ kind: "held" }],
		});
		expect(existsSync(mockState.preparedManifestPath)).toBe(true);
	});

});
