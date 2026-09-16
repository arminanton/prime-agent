import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProcessStartId } from "../../core/session-lease.js";
import { isProcessAlive } from "../../utils/child-process.js";
import { normalizeSocketPath } from "./daemon-socket.js";
import type { DaemonWorkerDescriptor } from "./daemon-worker-protocol.js";

export function isDaemonWorkerDescriptor(value: unknown, socketPath: string): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	return (
		(descriptor.version === 1 || descriptor.version === 2) &&
		typeof descriptor.supervisorSocketPath === "string" &&
		normalizeSocketPath(descriptor.supervisorSocketPath) === socketPath &&
		typeof descriptor.workerId === "string" &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || typeof descriptor.processStartId === "string") &&
		(descriptor.ownerClientId === undefined || typeof descriptor.ownerClientId === "string") &&
		typeof descriptor.socketPath === "string" &&
		typeof descriptor.authenticationToken === "string" &&
		(descriptor.workerInstanceId === undefined || typeof descriptor.workerInstanceId === "string") &&
		typeof descriptor.rootActiveSessionId === "string" &&
		typeof descriptor.createdAt === "string" &&
		typeof descriptor.updatedAt === "string" &&
		Number.isInteger(descriptor.consecutiveFailures) &&
		descriptor.createCommand !== undefined && descriptor.createCommand !== null &&
		typeof descriptor.createCommand === "object" &&
		descriptor.createCommand.type === "create"
	);
}

export function descriptorKey(socketPath: string): string {
	return createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex").slice(0, 12);
}

export function defaultWorkerDescriptorDir(agentDir: string, socketPath: string): string {
	return join(agentDir, "daemon-workers", descriptorKey(socketPath));
}

export interface WorkerDescriptorInventoryEntry {
	descriptorPath: string;
	descriptor: DaemonWorkerDescriptor;
}

export function readWorkerDescriptorInventory(agentDir: string, socketPath: string): WorkerDescriptorInventoryEntry[] {
	const normalized = normalizeSocketPath(socketPath);
	const directory = defaultWorkerDescriptorDir(agentDir, normalized);
	let names: string[];
	try { names = readdirSync(directory); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const entries: WorkerDescriptorInventoryEntry[] = [];
	for (const name of names.sort()) {
		if (!name.endsWith(".json")) continue;
		const descriptorPath = join(directory, name);
		let value: unknown;
		try { value = JSON.parse(readFileSync(descriptorPath, "utf8")); } catch { continue; }
		if (isDaemonWorkerDescriptor(value, normalized)) entries.push({ descriptorPath, descriptor: value });
	}
	return entries;
}

export interface LiveWorkerProcess {
	workerId: string;
	pid: number;
	processStartId?: string;
	rootActiveSessionId: string;
	lifecycle: string;
	stopRequestedAt?: string;
	descriptorPath: string;
	identity: "current" | "unknown";
}

/** Dead/zombie and reused pids are excluded; an unobservable identity remains a live hold. */
export function scanLiveWorkerProcesses(agentDir: string, socketPath: string): LiveWorkerProcess[] {
	const live: LiveWorkerProcess[] = [];
	for (const { descriptor: worker, descriptorPath } of readWorkerDescriptorInventory(agentDir, socketPath)) {
		if (!isProcessAlive(worker.pid)) continue;
		const observed = getProcessStartId(worker.pid);
		if (worker.processStartId !== undefined && observed !== undefined && observed !== worker.processStartId) continue;
		live.push({ workerId: worker.workerId, pid: worker.pid, processStartId: worker.processStartId,
			rootActiveSessionId: worker.rootActiveSessionId, lifecycle: worker.lifecycle, stopRequestedAt: worker.stopRequestedAt,
			descriptorPath, identity: observed === undefined || worker.processStartId === undefined ? "unknown" : "current" });
	}
	return live;
}
