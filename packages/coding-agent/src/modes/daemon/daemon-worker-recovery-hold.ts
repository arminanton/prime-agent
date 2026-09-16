import type { DaemonWorkerDescriptor } from "./daemon-worker-protocol.js";

/** Local descriptor-file annotation only. Never part of a worker or public wire message. */
export interface DaemonWorkerRecoveryHold {
	reason: "update_restart_recovery_uncertain";
	pid: number;
	processStartId?: string;
	rootActiveSessionId: string;
	activeSessionIds: string[];
	manifestCreatedAt: string;
	createdAt: string;
}

export function readDaemonWorkerRecoveryHold(descriptor: DaemonWorkerDescriptor): DaemonWorkerRecoveryHold | undefined {
	const value = (descriptor as DaemonWorkerDescriptor & { updateRestartRecoveryHold?: unknown }).updateRestartRecoveryHold;
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object") throw new Error("Invalid update restart recovery hold");
	const hold = value as Partial<DaemonWorkerRecoveryHold>;
	if (hold.reason !== "update_restart_recovery_uncertain" || hold.pid !== descriptor.pid ||
		hold.processStartId !== descriptor.processStartId || hold.rootActiveSessionId !== descriptor.rootActiveSessionId ||
		!Array.isArray(hold.activeSessionIds) || !hold.activeSessionIds.every((id) => typeof id === "string" && id.length > 0) ||
		typeof hold.manifestCreatedAt !== "string" || !Number.isFinite(Date.parse(hold.manifestCreatedAt)) ||
		typeof hold.createdAt !== "string" || !Number.isFinite(Date.parse(hold.createdAt))) {
		throw new Error("Update restart recovery hold does not match the worker descriptor");
	}
	return hold as DaemonWorkerRecoveryHold;
}

export function withDaemonWorkerRecoveryHold(
	descriptor: DaemonWorkerDescriptor,
	hold: DaemonWorkerRecoveryHold | undefined,
): DaemonWorkerDescriptor & { updateRestartRecoveryHold?: DaemonWorkerRecoveryHold } {
	if (!hold) return descriptor;
	const persisted = { ...descriptor, updateRestartRecoveryHold: hold };
	readDaemonWorkerRecoveryHold(persisted);
	return persisted;
}

export function workerRecoveryHoldMessage(hold: DaemonWorkerRecoveryHold): string {
	return `Update restart recovery-uncertain: worker ${hold.pid} has not retired; session leases and recovery evidence are retained until it exits`;
}
