import { describe, expect, it } from "vitest";
import { createWorkerMemoryReliefPlan } from "../src/modes/daemon/worker-memory-pressure.js";

function sample(heapRatio: number) {
	const heapLimitBytes = 4 * 1024 * 1024 * 1024;
	return {
		heapUsedBytes: Math.round(heapLimitBytes * heapRatio),
		heapLimitBytes,
		rssBytes: Math.round(heapLimitBytes * heapRatio),
	};
}

describe("worker memory pressure policy", () => {
	it("does nothing below both heap and resident-session watermarks", () => {
		expect(createWorkerMemoryReliefPlan(sample(0.69), 32)).toEqual({
			level: "normal",
			heapRatio: 0.69,
			residentSessionExcess: 0,
			shouldPassivate: false,
			passivationLimit: 0,
			blockNewSubagents: false,
		});
	});

	it("drains safe children when resident runtime count exceeds its soft limit", () => {
		expect(createWorkerMemoryReliefPlan(sample(0.4), 45)).toMatchObject({
			level: "normal",
			residentSessionExcess: 13,
			shouldPassivate: true,
			passivationLimit: 13,
			blockNewSubagents: false,
		});
	});

	it("escalates passivation and blocks new subagents at critical heap pressure", () => {
		expect(createWorkerMemoryReliefPlan(sample(0.9), 20)).toMatchObject({
			level: "critical",
			residentSessionExcess: 0,
			shouldPassivate: true,
			passivationLimit: 32,
			blockNewSubagents: true,
		});
	});
});
