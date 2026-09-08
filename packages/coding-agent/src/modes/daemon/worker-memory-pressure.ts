import { getHeapStatistics } from "node:v8";

export const WORKER_MEMORY_CHECK_INTERVAL_MS = 15_000;
export const WORKER_MEMORY_HIGH_WATERMARK = 0.7;
export const WORKER_MEMORY_CRITICAL_WATERMARK = 0.85;
export const WORKER_RESIDENT_SESSION_SOFT_LIMIT = 32;
export const WORKER_MEMORY_MAX_PASSIVATION_BATCH = 64;

const WORKER_MEMORY_HIGH_PASSIVATION_BATCH = 8;
const WORKER_MEMORY_CRITICAL_PASSIVATION_BATCH = 32;

export interface WorkerMemorySnapshot {
	heapUsedBytes: number;
	heapLimitBytes: number;
	rssBytes: number;
}

export type WorkerMemoryPressureLevel = "normal" | "high" | "critical";

export interface WorkerMemoryReliefPlan {
	level: WorkerMemoryPressureLevel;
	heapRatio: number;
	residentSessionExcess: number;
	shouldPassivate: boolean;
	passivationLimit: number;
	blockNewSubagents: boolean;
}

export function readWorkerMemorySnapshot(): WorkerMemorySnapshot {
	const memory = process.memoryUsage();
	return {
		heapUsedBytes: memory.heapUsed,
		heapLimitBytes: getHeapStatistics().heap_size_limit,
		rssBytes: memory.rss,
	};
}

export function createWorkerMemoryReliefPlan(
	snapshot: WorkerMemorySnapshot,
	residentSessionCount: number,
): WorkerMemoryReliefPlan {
	const rawRatio = snapshot.heapLimitBytes > 0 ? snapshot.heapUsedBytes / snapshot.heapLimitBytes : 0;
	const heapRatio = Math.round(rawRatio * 10_000) / 10_000;
	const level: WorkerMemoryPressureLevel =
		heapRatio >= WORKER_MEMORY_CRITICAL_WATERMARK
			? "critical"
			: heapRatio >= WORKER_MEMORY_HIGH_WATERMARK
				? "high"
				: "normal";
	const residentSessionExcess = Math.max(0, residentSessionCount - WORKER_RESIDENT_SESSION_SOFT_LIMIT);
	const shouldPassivate = level !== "normal" || residentSessionExcess > 0;
	const pressureBatch =
		level === "critical"
			? WORKER_MEMORY_CRITICAL_PASSIVATION_BATCH
			: level === "high"
				? WORKER_MEMORY_HIGH_PASSIVATION_BATCH
				: 0;
	const passivationLimit = shouldPassivate
		? Math.min(WORKER_MEMORY_MAX_PASSIVATION_BATCH, Math.max(pressureBatch, residentSessionExcess))
		: 0;
	return {
		level,
		heapRatio,
		residentSessionExcess,
		shouldPassivate,
		passivationLimit,
		blockNewSubagents: level === "critical",
	};
}
