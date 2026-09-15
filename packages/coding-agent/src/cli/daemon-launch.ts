/**
 * Daemon launch/readiness helpers.
 *
 * This module stays light on imports so clients can start a cold daemon before
 * the heavy main module graph loads. main.ts reuses the same memoized promise.
 */

import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendRotatingLog, expandTildePath, getClientErrorLogPath, getDaemonLogPath, VERSION } from "../config.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../core/orphan-process-journal.js";
import { getProcessStartId, SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../core/session-lease.js";
import { DaemonClient, type DaemonHello } from "../modes/daemon/daemon-client.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../modes/daemon/daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "../modes/daemon/daemon-runtime-identity.js";
import { isSessionSummaryBusy, type SessionSummary } from "../modes/daemon/daemon-session-list.js";
import { defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
} from "../modes/daemon/daemon-worker-protocol.js";
import { spawnHidden } from "../utils/child-process.js";
import { isHelpCommandRequest, PUBLIC_COMMAND_NAMES, REMOVED_COMMAND_NAMES } from "./command-registry.js";
import { createCliSubprocessEnv, formatCurrentCliCommand } from "./subprocess-launch.js";

const DAEMON_STARTUP_TIMEOUT_MS = 30_000;
const DAEMON_STARTUP_LOG_TAIL_BYTES = 4 * 1024;
const DAEMON_STARTUP_EXIT_GRACE_MS = 2_000;

export function isDaemonSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const summary = value as { activeSessionId?: unknown; id?: unknown };
	return typeof summary.activeSessionId === "string" || typeof summary.id === "string";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Daemon replacement used to be silent (no crash, no log), so a daemon dying
// out from under another window looked "random". Trace the decisions to the
// client-errors log so replacements are attributable after the fact.
function logDaemonLaunch(message: string): void {
	appendRotatingLog(getClientErrorLogPath(), `[${new Date().toISOString()}] daemon-launch: ${message}`);
}

async function canConnectToDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

type DaemonVersionProbe =
	| { status: "absent" }
	| { status: "current"; hello: DaemonHello }
	| { status: "stale"; hello: DaemonHello }
	| { status: "unresponsive" };

function isCurrentDaemonHello(hello: DaemonHello): boolean {
	return (
		hello.protocol.version === DAEMON_PROTOCOL_VERSION &&
		hello.schemaId === DAEMON_SCHEMA_ID &&
		hello.appVersion === VERSION
	);
}

/** Connect to a running daemon and check whether it matches this client's protocol and app version. */
export async function probeDaemonVersion(socketPath: string, helloTimeoutMs = 2000): Promise<DaemonVersionProbe> {
	let client: DaemonClient | undefined;
	for (const timeoutMs of [250, 2000]) {
		const candidate = new DaemonClient(socketPath);
		try {
			await candidate.connect(timeoutMs);
			client = candidate;
			break;
		} catch {
			candidate.close();
		}
	}
	if (!client) {
		return { status: "absent" };
	}
	try {
		const hello = await client.waitForHello(helloTimeoutMs);
		const current = isCurrentDaemonHello(hello);
		if (!current) {
			logDaemonLaunch(
				`running daemon on ${socketPath} is stale: daemon v${hello.appVersion}/proto${hello.protocol.version}` +
					`/schema ${hello.schemaId ?? "legacy"}/build ${hello.runtime?.buildId ?? "unknown"} vs client ` +
					`v${VERSION}/proto${DAEMON_PROTOCOL_VERSION}/schema ${DAEMON_SCHEMA_ID}/build ${getDaemonRuntimeIdentity().buildId}`,
			);
		}
		if (current) {
			return { status: "current", hello };
		}
		return { status: "stale", hello };
	} catch {
		// The supervisor accepts connections before startup and worker adoption finish.
		logDaemonLaunch(`running daemon on ${socketPath} sent no recognizable hello; waiting for startup`);
		return { status: "unresponsive" };
	} finally {
		client.close();
	}
}

export async function listActiveDaemonSessionSummaries(
	client: DaemonClient,
	options: { includeClientOwned?: boolean } = {},
): Promise<SessionSummary[]> {
	return (await queryActiveDaemonSessions(client, options)).sessions;
}

async function queryActiveDaemonSessions(
	client: DaemonClient,
	options: { includeClientOwned?: boolean } = {},
): Promise<{ sessions: SessionSummary[]; busyClientOwnedSessionCount: number }> {
	const response = await client.request({ type: "list", includeClientOwned: options.includeClientOwned });
	if (!response.success) {
		throw new Error(response.error);
	}
	const data = response.data;
	if (!data || typeof data !== "object" || !("sessions" in data)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	const sessions = (data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	if (!sessions.every(isDaemonSessionSummary)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	const busyClientOwnedSessionCount = (data as { busyClientOwnedSessionCount?: unknown }).busyClientOwnedSessionCount;
	if (
		busyClientOwnedSessionCount !== undefined &&
		(typeof busyClientOwnedSessionCount !== "number" ||
			!Number.isInteger(busyClientOwnedSessionCount) ||
			busyClientOwnedSessionCount < 0)
	) {
		throw new Error("Daemon returned an invalid client-owned session count");
	}
	return { sessions, busyClientOwnedSessionCount: busyClientOwnedSessionCount ?? 0 };
}

/** Thrown when a stale-version daemon can't be replaced. The message is user-facing. */
export class StaleDaemonError extends Error {
	constructor(
		readonly socketPath: string,
		hello?: DaemonHello,
	) {
		const daemonIdentity = hello
			? `Daemon: v${hello.appVersion ?? "unknown"}, protocol ${hello.protocol.version}, schema ${hello.schemaId ?? "legacy"}, ` +
				`build ${hello.runtime?.buildId ?? "unknown"}, PID ${hello.supervisorPid ?? "unknown"}, ` +
				`executable ${hello.runtime?.launcherPath ?? hello.runtime?.entrypointPath ?? hello.runtime?.executablePath ?? "unknown"}`
			: `Daemon: unknown build on ${socketPath}`;
		const client = getDaemonRuntimeIdentity();
		super(
			`An incompatible Prime Agent daemon is running.\n\n${daemonIdentity}\n` +
				`Client: v${VERSION}, protocol ${DAEMON_PROTOCOL_VERSION}, schema ${DAEMON_SCHEMA_ID}, build ${client.buildId}, ` +
				`executable ${client.launcherPath ?? client.entrypointPath ?? client.executablePath}\n\nRun:\n` +
				`${formatCurrentCliCommand(["shutdown", "--force"])}\n\nThen retry the original command.`,
		);
		this.name = "StaleDaemonError";
	}
}

interface DaemonProcessIdentity {
	pid: number;
	processStartId?: string;
}

const PROCESS_START_ID_POLL_INTERVAL_MS = 1000;

function hasProcessIdentityExited(identity: DaemonProcessIdentity | undefined, verifyProcessStartId = true): boolean {
	if (!identity) {
		return true;
	}
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	if (!identity.processStartId || !verifyProcessStartId) {
		return false;
	}
	const currentStartId = getProcessStartId(identity.pid);
	return currentStartId !== undefined && currentStartId !== identity.processStartId;
}

async function waitForDaemonGone(
	socketPath: string,
	timeoutMs = 5000,
	requireSocketCleanup = false,
	expectedIdentity?: DaemonProcessIdentity,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let nextProcessStartIdPollAt = 0;
	const hasExpectedProcessExited = (forceStartIdPoll = false) => {
		const now = Date.now();
		const verifyProcessStartId = forceStartIdPoll || now >= nextProcessStartIdPollAt;
		if (verifyProcessStartId) {
			nextProcessStartIdPollAt = now + PROCESS_START_ID_POLL_INTERVAL_MS;
		}
		return hasProcessIdentityExited(expectedIdentity, verifyProcessStartId);
	};
	while (Date.now() < deadline) {
		if (
			!(await canConnectToDaemon(socketPath, 250)) &&
			(!requireSocketCleanup || process.platform === "win32" || !existsSync(socketPath)) &&
			hasExpectedProcessExited()
		) {
			return true;
		}
		await delay(25);
	}
	// A daemon can exit without removing its Unix socket (for example, after a crash
	// during shutdown). Once the cleanup grace has elapsed, a non-listening socket
	// is safe for the replacement daemon's guarded startup path to reclaim.
	return requireSocketCleanup && !(await canConnectToDaemon(socketPath, 250)) && hasExpectedProcessExited(true);
}

function processIdentityFromDaemonHello(hello: DaemonHello | undefined): DaemonProcessIdentity | undefined {
	if (!hello?.supervisorPid || !Number.isInteger(hello.supervisorPid) || hello.supervisorPid <= 0) {
		return undefined;
	}
	const processStartId = hello.supervisorProcessStartId ?? getProcessStartId(hello.supervisorPid);
	return {
		pid: hello.supervisorPid,
		...(processStartId ? { processStartId } : {}),
	};
}

export async function shutdownConnectedDaemonAndWait(
	client: DaemonClient,
	socketPath: string,
	timeoutMs = 5000,
	hello: DaemonHello | undefined = client.hello,
): Promise<boolean> {
	let shutdownAccepted = false;
	const expectedIdentity = processIdentityFromDaemonHello(hello);
	try {
		const response = await client.request({ type: "shutdown" }).catch(() => undefined);
		shutdownAccepted = response?.success === true;
	} catch {
		// A connect failure isn't treated as "gone"; waitForDaemonGone is the source of truth.
	} finally {
		client.close();
	}
	return waitForDaemonGone(socketPath, timeoutMs, shutdownAccepted, expectedIdentity);
}

export async function shutdownDaemonAndWait(socketPath: string, timeoutMs = 5000): Promise<boolean> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
		const hello = await client.waitForHello(2000).catch(() => undefined);
		return shutdownConnectedDaemonAndWait(client, socketPath, timeoutMs, hello);
	} catch {
		client.close();
		return waitForDaemonGone(socketPath, timeoutMs);
	}
}

// activeSessions is undefined when the daemon is reachable but its sessions couldn't
// be listed — callers must treat that as "possibly busy", not idle.
export type RunningDaemonProbe =
	| { reachable: false }
	| { reachable: true; activeSessions?: SessionSummary[]; busyClientOwnedSessionCount?: number };

export function isSessionBusy(summary: SessionSummary): boolean {
	return isSessionSummaryBusy(summary);
}

export async function probeRunningDaemonSessions(socketPath: string): Promise<RunningDaemonProbe> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return { reachable: false };
	}
	try {
		const result = await queryActiveDaemonSessions(client, { includeClientOwned: true });
		return {
			reachable: true,
			activeSessions: result.sessions.filter((summary) => summary.activeSessionId !== undefined),
			...(result.busyClientOwnedSessionCount > 0
				? { busyClientOwnedSessionCount: result.busyClientOwnedSessionCount }
				: {}),
		};
	} catch {
		return { reachable: true };
	} finally {
		client.close();
	}
}

// Idle-but-loaded sessions reload from disk on the fresh daemon, so only a busy
// session blocks replacing a stale daemon.
type StaleDaemonDisposition = "current" | "stopped" | "busy";

async function shutdownStaleDaemonIfNotBusy(socketPath: string): Promise<StaleDaemonDisposition> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return (await waitForDaemonGone(socketPath)) ? "stopped" : "busy";
	}

	let loadedSessionCount = 0;
	let hasBusySessions = true;
	try {
		const result = await queryActiveDaemonSessions(client, { includeClientOwned: true });
		loadedSessionCount = result.sessions.length;
		hasBusySessions =
			result.busyClientOwnedSessionCount !== 0 || result.sessions.some((summary) => isSessionBusy(summary));
	} catch {
		// An unresponsive daemon is not safe to replace.
	}

	const hello = client.hello;
	if (hello && isCurrentDaemonHello(hello)) {
		client.close();
		logDaemonLaunch(`daemon on ${socketPath} finished starting while staleness was being checked; reusing it`);
		return "current";
	}
	if (hasBusySessions) {
		client.close();
		logDaemonLaunch(`refusing to replace stale daemon on ${socketPath}: busy session(s) present`);
		return "busy";
	}
	logDaemonLaunch(
		`replacing stale daemon on ${socketPath} (idle): ${loadedSessionCount} loaded session(s) will reload`,
	);
	return (await shutdownConnectedDaemonAndWait(client, socketPath, 5000, hello)) ? "stopped" : "busy";
}

export interface DaemonLaunchInvocation {
	command: string;
	args: string[];
	scoped: boolean;
	warning?: string;
}

function findExecutableOnPath(name: string): string | undefined {
	const pathValue = process.env.PATH;
	if (!pathValue) return undefined;
	for (const dir of pathValue.split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			// Presence is not enough: a non-executable file on PATH would fail at spawn, so
			// require X_OK here and treat a non-executable hit as "not found" (fall back).
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not a file here, or not executable; keep looking.
		}
	}
	return undefined;
}

/**
 * Optionally wrap the daemon launch in a systemd --user transient scope under a fixed capped
 * PARENT slice (prime-agent.slice), so the supervisor, all workers, kernels, and uv helpers
 * inherit one memory-bounded cgroup that a shell-driven restart cannot drop back into the SSH
 * login scope. The MemoryMax/MemorySwapMax/MemoryOOMGroup caps live on the SLICE (set once by
 * the deploy, see DEPLOY-A-RUNBOOK.md), not on each scope, so overlapping old and new scopes
 * during a restart share ONE cap and adopted workers in old scopes still count against it.
 *
 * The scope is auto-named (no fixed --unit): a fixed scope name collides on a rapid restart and
 * when the in-scope update coordinator restarts the successor ("Unit ...scope already exists",
 * exit 1). Opt-in and reversible via PRIME_AGENT_DAEMON_SCOPE=1; if systemd-run is missing or
 * not executable it falls back to the unscoped launch with a warning. The parent slice is
 * overridable via PRIME_AGENT_DAEMON_SLICE for testing. Never applied unless the env asks.
 */
export function buildDaemonScopeInvocation(command: string, args: readonly string[]): DaemonLaunchInvocation {
	if (process.env.PRIME_AGENT_DAEMON_SCOPE !== "1") {
		return { command, args: [...args], scoped: false };
	}
	const systemdRun = findExecutableOnPath("systemd-run");
	if (!systemdRun) {
		return {
			command,
			args: [...args],
			scoped: false,
			warning:
				"PRIME_AGENT_DAEMON_SCOPE=1 but an executable systemd-run was not found on PATH; launching the daemon unscoped.",
		};
	}
	const slice = process.env.PRIME_AGENT_DAEMON_SLICE ?? "prime-agent.slice";
	const scopeArgs = ["--user", "--scope", `--slice=${slice}`, "--collect", "--", command, ...args];
	return { command: systemdRun, args: scopeArgs, scoped: true };
}

async function ensureDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	const probeStartedAt = Date.now();
	let probe = await probeDaemonVersion(socketPath);
	if (probe.status === "unresponsive") {
		const remainingStartupMs = Math.max(1, DAEMON_STARTUP_TIMEOUT_MS - (Date.now() - probeStartedAt));
		probe = await probeDaemonVersion(socketPath, remainingStartupMs);
	}
	if (probe.status === "current") {
		return;
	}
	if (probe.status === "unresponsive") {
		throw new Error(
			`Prime Agent daemon on ${socketPath} accepted connections but did not finish startup within ${DAEMON_STARTUP_TIMEOUT_MS / 1000} seconds. ` +
				`It was left running to avoid interrupting active work.

Run:
${formatCurrentCliCommand(["shutdown", "--force"])}

Then retry the original command.`,
		);
	}
	if (probe.status === "stale") {
		const disposition = await shutdownStaleDaemonIfNotBusy(socketPath);
		if (disposition === "current") return;
		if (disposition === "busy") throw new StaleDaemonError(socketPath, probe.hello);
	}

	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for daemon launch");
	}

	// Strip inherited daemon worker/supervisor role env vars so the spawned
	// daemon supervisor does not inherit worker-mode behavior. Without this,
	// a CLI running inside a daemon worker (e.g. a test spawned by the Prime
	// Agent daemon) would launch the supervisor in worker mode, which listens
	// on the socket but never sends the daemon_hello handshake.
	const env = createCliSubprocessEnv();
	delete env[DAEMON_WORKER_ROLE_ENV];
	delete env[DAEMON_WORKER_TOKEN_ENV];
	delete env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
	delete env[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
	delete env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
	delete env[ORPHAN_PROCESS_JOURNAL_ENV];
	delete env[SESSION_LEASES_ENABLED_ENV];
	delete env[SESSION_LEASE_OWNER_ID_ENV];

	const daemonArgs = [...process.execArgv, entrypoint, "--mode", "daemon", "--daemon-socket", socketPath];
	const invocation = buildDaemonScopeInvocation(process.execPath, daemonArgs);
	if (invocation.warning) {
		logDaemonLaunch(invocation.warning);
	} else if (invocation.scoped) {
		logDaemonLaunch(`launching daemon in a systemd --user scope via ${invocation.command}`);
	}

	const attempt = await attemptDaemonLaunch(invocation, socketPath, env, spawnCwd ?? process.cwd());
	if (attempt.started) {
		return;
	}

	// R5: a scoped launch that exits before the socket appears (a scope-unit collision on rapid
	// restart, an unreachable user bus in a cron/heartbeat context, a rejected property, or a
	// missing slice) must never lock the user out of the daemon. Retry UNSCOPED exactly once,
	// loudly: cgroup containment was NOT applied for this launch, so the host cutover gate
	// (DEPLOY-A-RUNBOOK.md) must verify supervisor+worker+kernel cgroup membership before the
	// user-400.slice soft cap is removed.
	if (invocation.scoped) {
		logDaemonLaunch(
			`scoped daemon launch failed; retrying UNSCOPED once (cgroup containment NOT applied for this launch). ${attempt.message}`,
		);
		const unscoped = await attemptDaemonLaunch(
			{ command: process.execPath, args: [...daemonArgs], scoped: false },
			socketPath,
			env,
			spawnCwd ?? process.cwd(),
		);
		if (unscoped.started) {
			return;
		}
		throw new Error(unscoped.message);
	}

	throw new Error(attempt.message);
}

type DaemonLaunchAttempt = { started: true } | { started: false; message: string };

/**
 * Spawn one detached daemon launch and probe for its socket. Returns started=true once the
 * socket answers with a current version, or a diagnostic message otherwise. For a scoped launch
 * systemd-run's own stderr is captured to a sidecar file so a scope-creation failure is logged
 * instead of discarded (the daemon inside the scope logs via its own writer, so raw stderr is
 * minimal); the message includes both the daemon log tail and any systemd-run stderr.
 */
async function attemptDaemonLaunch(
	invocation: DaemonLaunchInvocation,
	socketPath: string,
	env: NodeJS.ProcessEnv,
	spawnCwd: string,
): Promise<DaemonLaunchAttempt> {
	const logOffset = currentDaemonLogSize(socketPath);
	const scopeStderrPath = invocation.scoped ? `${getDaemonLogPath(socketPath)}.scope-launch` : undefined;
	let scopeStderrFd: number | undefined;
	if (scopeStderrPath) {
		try {
			scopeStderrFd = openSync(scopeStderrPath, "w");
		} catch {
			scopeStderrFd = undefined;
		}
	}
	const child = spawnHidden(invocation.command, invocation.args, {
		cwd: spawnCwd,
		detached: true,
		env,
		// A pipe would tie the daemon's stderr to this short-lived CLI (EPIPE once it exits);
		// crash details come from the daemon log. systemd-run's own stderr goes to a sidecar file
		// so a scope-creation failure is captured; everything else is discarded.
		stdio: scopeStderrFd !== undefined ? ["ignore", "ignore", scopeStderrFd] : "ignore",
	});
	if (scopeStderrFd !== undefined) {
		try {
			closeSync(scopeStderrFd);
		} catch {
			// The child kept its dup; closing the parent copy is best-effort.
		}
	}
	let childFailure:
		| { type: "error"; error: Error }
		| { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
		| undefined;
	child.once("error", (error) => {
		childFailure ??= { type: "error", error };
	});
	child.once("exit", (code, signal) => {
		childFailure ??= { type: "exit", code, signal };
	});
	child.unref();

	const readScopeStderr = (): string => {
		if (!scopeStderrPath) return "";
		try {
			return readFileSync(scopeStderrPath, "utf8").trim();
		} catch {
			return "";
		}
	};
	const cleanupScopeStderr = (): void => {
		if (!scopeStderrPath) return;
		try {
			rmSync(scopeStderrPath, { force: true });
		} catch {
			// Best-effort; a leftover sidecar is truncated by the next scoped launch.
		}
	};
	const failureMessage = (): string => {
		const logTail = readDaemonLogTail(socketPath, logOffset);
		const scopeErr = readScopeStderr();
		const scopeDetail = scopeErr ? ` systemd-run stderr: ${scopeErr}` : "";
		if (!childFailure) {
			return `Timed out waiting for daemon to start on ${socketPath}.${logTail}${scopeDetail}`;
		}
		if (childFailure.type === "error") {
			return `Failed to spawn Prime Agent daemon: ${childFailure.error.message}.${logTail}${scopeDetail}`;
		}
		const signal = childFailure.signal ? `, signal ${childFailure.signal}` : "";
		return `Prime Agent daemon exited during startup (code ${childFailure.code ?? "unknown"}${signal}).${logTail}${scopeDetail}`;
	};

	// A child exit is not immediately fatal: it may have lost the socket to a concurrent launcher
	// whose daemon is still booting. Keep probing for a short grace window before attributing the
	// failure to the exit.
	const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
	let exitDeadline: number | undefined;
	while (Date.now() < Math.min(deadline, exitDeadline ?? Number.POSITIVE_INFINITY)) {
		const started = await probeDaemonVersion(socketPath);
		if (started.status === "current") {
			cleanupScopeStderr();
			return { started: true };
		}
		if (childFailure) {
			exitDeadline ??= Date.now() + DAEMON_STARTUP_EXIT_GRACE_MS;
		}
		await delay(25);
	}

	const message = failureMessage();
	cleanupScopeStderr();
	return { started: false, message };
}

function currentDaemonLogSize(socketPath: string): number {
	try {
		return statSync(getDaemonLogPath(socketPath)).size;
	} catch {
		return 0;
	}
}

/** Reads only log content written after `offset`, so stale content from earlier daemon runs is not misattributed to this startup attempt. */
function readDaemonLogTail(socketPath: string, offset: number): string {
	const logPath = getDaemonLogPath(socketPath);
	let tail = "";
	try {
		const content = readFileSync(logPath);
		// A rotation may have shrunk the file below the pre-spawn byte offset.
		tail = content
			.subarray(content.length < offset ? 0 : offset)
			.subarray(-DAEMON_STARTUP_LOG_TAIL_BYTES)
			.toString("utf8")
			.trim();
	} catch {
		// Missing log means the daemon crashed before logging was set up.
	}
	return tail ? ` Recent daemon log (${logPath}):\n${tail}` : ` The daemon wrote nothing to its log (${logPath}).`;
}

const ensurePromises = new Map<string, Promise<void>>();

/**
 * Ensure a current-version daemon is listening on socketPath, spawning one if
 * needed. Memoized per socket so the early kick from cli.ts and the await in
 * main.ts share one probe/spawn; failed attempts are forgotten so a later call
 * retries (and surfaces the real error at its await site).
 */
export function ensureInteractiveDaemonRunning(socketPath: string, spawnCwd?: string): Promise<void> {
	let promise = ensurePromises.get(socketPath);
	if (!promise) {
		promise = ensureDaemonRunning(socketPath, spawnCwd);
		ensurePromises.set(socketPath, promise);
		const clear = () => {
			if (ensurePromises.get(socketPath) === promise) {
				ensurePromises.delete(socketPath);
			}
		};
		promise.then(clear, clear);
	}
	return promise;
}

const EARLY_LAUNCH_EXCLUDED_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);
const EARLY_LAUNCH_VALUE_FLAGS = new Set([
	"--mode",
	"--daemon-socket",
	"--provider",
	"--model",
	"--api-key",
	"--cwd",
	"--system-prompt",
	"--append-system-prompt",
	"--fork",
	"--session-dir",
	"--models",
	"--tools",
	"-t",
	"--thinking",
	"--extension",
	"-e",
	"--skill",
	"--prompt-template",
	"--theme",
	"--autonomous-gate",
	"--autonomous-gate-retries",
	"--autonomous-gate-timeout-ms",
	"--autonomous-max-continuations",
	"--autonomous-max-turns",
	"--autonomous-max-tokens",
	"--autonomous-timeout-ms",
	"--goal",
	"--goal-token-budget",
]);

function findFirstEarlyLaunchPositional(args: readonly string[]): { index: number; value: string } | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") {
			return args[index + 1] === undefined ? undefined : { index: index + 1, value: args[index + 1]! };
		}
		if (EARLY_LAUNCH_VALUE_FLAGS.has(arg)) {
			index++;
			continue;
		}
		if (arg === "--resume" || arg === "-r") {
			if (args[index + 1] && !args[index + 1]!.startsWith("-")) {
				index++;
			}
			continue;
		}
		if (!arg.startsWith("-")) {
			return { index, value: arg };
		}
	}
	return undefined;
}

export function shouldStartDaemonEarly(args: readonly string[], startupBenchmark: boolean): boolean {
	if (startupBenchmark) {
		return false;
	}
	const modeIndex = args.indexOf("--mode");
	if (modeIndex !== -1 && args[modeIndex + 1] === "daemon") {
		return false;
	}
	if (args.some((arg) => EARLY_LAUNCH_EXCLUDED_FLAGS.has(arg))) {
		return false;
	}
	if (args.includes("--print") || args.includes("-p")) {
		return true;
	}
	const firstPositional = findFirstEarlyLaunchPositional(args);
	const isHelpCommand =
		firstPositional?.value === "help" && isHelpCommandRequest(args.slice(firstPositional.index + 1));
	if (
		firstPositional &&
		(REMOVED_COMMAND_NAMES.has(firstPositional.value) ||
			(PUBLIC_COMMAND_NAMES.has(firstPositional.value) &&
				firstPositional.value !== "agents" &&
				(firstPositional.value !== "help" || isHelpCommand)))
	) {
		return false;
	}
	return true;
}

export function maybeStartDaemonEarly(args: readonly string[]): void {
	const benchmarkFlag = (process.env.PI_STARTUP_BENCHMARK ?? "").toLowerCase();
	const startupBenchmark = benchmarkFlag === "1" || benchmarkFlag === "true" || benchmarkFlag === "yes";
	if (!shouldStartDaemonEarly(args, startupBenchmark)) {
		return;
	}
	const socketIndex = args.indexOf("--daemon-socket");
	const rawSocketPath =
		socketIndex !== -1 && args[socketIndex + 1] ? (args[socketIndex + 1] as string) : defaultDaemonSocketPath();
	const cwdIndex = args.indexOf("--cwd");
	const cwdArg = cwdIndex !== -1 ? args[cwdIndex + 1] : undefined;
	const spawnCwd = cwdArg ? resolve(expandTildePath(cwdArg)) : undefined;
	if (spawnCwd && !existsSync(spawnCwd)) {
		return;
	}
	void ensureInteractiveDaemonRunning(normalizeSocketPath(rawSocketPath, spawnCwd), spawnCwd);
}
