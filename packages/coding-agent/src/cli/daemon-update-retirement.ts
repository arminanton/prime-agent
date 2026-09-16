import { readFileSync } from "node:fs";
import { getProcessStartId } from "../core/session-lease.js";
import type { DaemonUpdateRestartManifest } from "../modes/daemon/daemon-protocol.js";
import { normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import type { DaemonStartupFenceIdentity } from "../modes/daemon/daemon-supervisor-ownership.js";
import { isDaemonWorkerDescriptor, readWorkerDescriptorInventory, scanLiveWorkerProcesses, type WorkerDescriptorInventoryEntry } from "../modes/daemon/daemon-worker-descriptors.js";
import { withDaemonWorkerRecoveryHold } from "../modes/daemon/daemon-worker-recovery-hold.js";
import { writeFileAtomicSync } from "../utils/atomic-file.js";
import { isProcessAlive } from "../utils/child-process.js";
import type { DaemonProcessEscalation, DaemonUpdateRestartProcessIdentity } from "./daemon-update-restart.js";

export const UPDATE_RESTART_NO_ESCALATION_ENV = "PRIME_AGENT_UPDATE_RESTART_NO_ESCALATION";
export type ManifestProvenance = "prepare_rpc" | "pending_manifest_idle_daemon" | "pending_manifest_predecessor_dead";

export interface EscalationGateInput {
	fence: DaemonStartupFenceIdentity;
	predecessor?: DaemonUpdateRestartProcessIdentity;
	provenance?: ManifestProvenance;
	shutdownAccepted: boolean;
	socketConnectable: boolean;
	socketPath: string;
	disabledByEnv: boolean;
}

export function evaluatePredecessorEscalationGate(input: EscalationGateInput): { allowed: true } | { allowed: false; reason: string } {
	if (input.disabledByEnv) return { allowed: false, reason: `${UPDATE_RESTART_NO_ESCALATION_ENV} is set` };
	if (input.provenance !== "prepare_rpc" && input.provenance !== "pending_manifest_predecessor_dead")
		return { allowed: false, reason: "G1: manifest has no successful prepare or dead-predecessor provenance" };
	if (!input.shutdownAccepted) return { allowed: false, reason: "G2: predecessor did not accept shutdown" };
	if (input.socketConnectable) return { allowed: false, reason: "G3: predecessor is still listening" };
	const p = input.predecessor;
	if (!p || !p.processStartId || p.pid !== input.fence.pid || p.processStartId !== input.fence.processStartId ||
		p.supervisorOwnerToken !== input.fence.ownerToken || p.supervisorGeneration !== input.fence.supervisorGeneration ||
		normalizeSocketPath(input.socketPath) !== input.fence.socketPath)
		return { allowed: false, reason: "G4: startup fence does not name the prepared predecessor" };
	return { allowed: true };
}

export interface ExactProcessOperations {
	isAlive(pid: number): boolean;
	startId(pid: number): string | undefined;
	signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}
const processOperations: ExactProcessOperations = {
	isAlive: isProcessAlive, startId: getProcessStartId, signal: (pid, signal) => { process.kill(pid, signal); },
};

type ExactIdentity = { pid: number; processStartId?: string };
function probeIdentity(identity: ExactIdentity, ops: ExactProcessOperations): "dead" | "current" | "unknown" {
	if (!ops.isAlive(identity.pid)) return "dead";
	if (!identity.processStartId) return "unknown";
	const observed = ops.startId(identity.pid);
	return observed === undefined ? "unknown" : observed === identity.processStartId ? "current" : "dead";
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - performance.now()))));
	}
}

/** An unknown identity is a hold, never proof of death and never authority to signal. */
export async function escalateExactProcess(
	identity: ExactIdentity,
	options: { operations?: ExactProcessOperations; assertAdmission?: () => Promise<void>; onProgress?: (report: DaemonProcessEscalation) => void } = {},
): Promise<DaemonProcessEscalation> {
	if (!Number.isInteger(identity.pid) || identity.pid <= 0) throw new Error("blocked: retirement requires a positive exact pid");
	const ops = options.operations ?? processOperations;
	const signals: string[] = [];
	const report = (outcome: string): DaemonProcessEscalation => {
		const value = { pid: identity.pid, processStartId: identity.processStartId, signals: [...signals], outcome, at: new Date().toISOString() };
		options.onProgress?.(value); return value;
	};
	for (const [signal, grace] of [["SIGTERM", 3000], ["SIGKILL", 2000]] as const) {
		const before = probeIdentity(identity, ops);
		if (before !== "current") return report(before === "dead" ? "dead" : "identity_unknown");
		await options.assertAdmission?.();
		// No await between this exact pid/start-id recheck and the positive-pid signal.
		const current = probeIdentity(identity, ops);
		if (current !== "current") return report(current === "dead" ? "dead" : "identity_unknown");
		try { ops.signal(identity.pid, signal); signals.push(signal); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return report("dead");
			report("blocked");
			throw new Error(`blocked: could not send ${signal} to exact process ${identity.pid}: ${String(error)}`);
		}
		report(signal === "SIGTERM" ? "term_sent" : "kill_sent");
		await pollUntil(() => probeIdentity(identity, ops) !== "current", grace);
	}
	const final = probeIdentity(identity, ops);
	return report(final === "current" ? "survived_sigkill" : final === "dead" ? "dead" : "identity_unknown");
}

/** Successful PREPARE plus this captured intersection is the legacy epoch authority. */
export function captureCommittedEpochWorkers(agentDir: string, socketPath: string, manifest: DaemonUpdateRestartManifest): WorkerDescriptorInventoryEntry[] {
	const roots = new Set([...manifest.sessions.map((session) => session.activeSessionId), ...(manifest.discardedActiveSessionIds ?? [])]);
	return readWorkerDescriptorInventory(agentDir, socketPath).filter(({ descriptor }) =>
		roots.has(descriptor.rootActiveSessionId) && descriptor.stopRequestedAt === undefined && descriptor.archiveOnStop !== true);
}

export function heldManifestSessionIds(manifest: DaemonUpdateRestartManifest, roots: ReadonlySet<string>): Set<string> {
	const held = new Set(roots);
	let changed = true;
	while (changed) {
		changed = false;
		for (const session of manifest.sessions) {
			if (session.runtimeMetadata?.parentActiveSessionId && held.has(session.runtimeMetadata.parentActiveSessionId) && !held.has(session.activeSessionId)) {
				held.add(session.activeSessionId); changed = true;
			}
		}
	}
	return held;
}

function rereadCapturedWorker(entry: WorkerDescriptorInventoryEntry, socketPath: string) {
	let value: unknown;
	try { value = JSON.parse(readFileSync(entry.descriptorPath, "utf8")); } catch { return undefined; }
	const expected = entry.descriptor;
	if (!isDaemonWorkerDescriptor(value, normalizeSocketPath(socketPath)) || value.workerId !== expected.workerId ||
		value.pid !== expected.pid || value.processStartId !== expected.processStartId ||
		value.workerInstanceId !== expected.workerInstanceId || value.rootActiveSessionId !== expected.rootActiveSessionId) return undefined;
	return value;
}

export async function escalateCommittedEpochWorkers(options: {
	agentDir: string; socketPath: string; manifest: DaemonUpdateRestartManifest; workers: readonly WorkerDescriptorInventoryEntry[];
	allowSignals: boolean; assertAdmission: () => Promise<void>;
	onProgress: (reports: Array<DaemonProcessEscalation & { workerId: string; rootActiveSessionId: string }>) => void;
	operations?: ExactProcessOperations;
}): Promise<Set<string>> {
	const ops = options.operations ?? processOperations;
	// Re-scan durable state immediately before escalation. The captured inventory,
	// not the whole directory, remains the authority for any process signal.
	const live = new Set(scanLiveWorkerProcesses(options.agentDir, options.socketPath).map((worker) => worker.descriptorPath));
	const heldRoots = new Set<string>();
	const reports = new Map<string, DaemonProcessEscalation & { workerId: string; rootActiveSessionId: string }>();
	const outcomes = await Promise.allSettled(options.workers.map(async (entry) => {
		const descriptor = entry.descriptor;
		const preserve = () => {
			const current = rereadCapturedWorker(entry, options.socketPath);
			if (current && (current.stopRequestedAt !== undefined || current.archiveOnStop)) {
				// Legacy shutdown incorrectly upgrades update survivors to terminal
				// stops. The captured PREPARE member had no such intent. Restore its
				// preservation semantics only after its supervisor has retired.
				delete current.stopRequestedAt;
				if (descriptor.archiveOnStop === undefined) delete current.archiveOnStop;
				else current.archiveOnStop = descriptor.archiveOnStop;
				writeFileAtomicSync(entry.descriptorPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
			}
		};
		await options.assertAdmission();
		preserve();
		if (!live.has(entry.descriptorPath) && probeIdentity(descriptor, ops) === "dead") return;
		const record = (result: DaemonProcessEscalation) => {
			reports.set(descriptor.workerId, { ...result, workerId: descriptor.workerId, rootActiveSessionId: descriptor.rootActiveSessionId });
			options.onProgress([...reports.values()]);
		};
		let report: DaemonProcessEscalation;
		if (!rereadCapturedWorker(entry, options.socketPath) || !options.allowSignals) {
			report = { pid: descriptor.pid, processStartId: descriptor.processStartId, signals: [], outcome: "recovery_uncertain", at: new Date().toISOString() };
			record(report);
		} else {
			report = await escalateExactProcess(descriptor, { operations: ops, onProgress: record, assertAdmission: async () => {
				await options.assertAdmission();
				if (!rereadCapturedWorker(entry, options.socketPath)) throw new Error(`blocked: worker descriptor changed for ${descriptor.workerId}`);
			} });
		}
		if (report.outcome === "dead") return;
		heldRoots.add(descriptor.rootActiveSessionId);
		await options.assertAdmission();
		const current = rereadCapturedWorker(entry, options.socketPath);
		if (current) {
			const activeSessionIds = [...heldManifestSessionIds(options.manifest, new Set([current.rootActiveSessionId]))];
			const annotated = withDaemonWorkerRecoveryHold(current, { reason: "update_restart_recovery_uncertain",
				pid: current.pid, processStartId: current.processStartId, rootActiveSessionId: current.rootActiveSessionId,
				activeSessionIds, manifestCreatedAt: options.manifest.createdAt, createdAt: new Date().toISOString() });
			writeFileAtomicSync(entry.descriptorPath, `${JSON.stringify(annotated, null, 2)}\n`, { mode: 0o600 });
		}
	}));
	const blocked = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
	if (blocked) throw blocked.reason;
	return heldManifestSessionIds(options.manifest, heldRoots);
}
