import { describe, expect, it } from "vitest";
import type { DaemonUpdateRestartManifest } from "../src/modes/daemon/daemon-protocol.js";
import type { DaemonUpdateRestartStatus } from "../src/cli/daemon-update-restart.js";
import { planDaemonRestoreContinuation } from "../src/package-manager-cli.js";
const successor = { pid: 123, processStartId: "start", supervisorGeneration: "generation", supervisorOwnerToken: "owner" };
const manifest = { formatVersion: 1, createdAt: "2026-01-01T00:00:00.000Z", sessions: [
	{ activeSessionId: "resolved", sessionFile: "/memory/resolved.jsonl" },
	{ activeSessionId: "failed", sessionFile: "/memory/failed.jsonl" },
] } as DaemonUpdateRestartManifest;
const previous = (): DaemonUpdateRestartStatus => ({ version: 1, requestId: "previous", socketPath: "/memory/daemon.sock", phase: "complete",
	coordinator: { pid: 456 }, successor, manifestCreatedAt: manifest.createdAt,
	counts: { total: 2, restored: 1, resumed: 0, failed: 1 }, failures: [{ sessionFile: "/memory/failed.jsonl", kind: "create_failed", message: "create failed" }],
	startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z" });

describe("status-bound continuation", () => {
	it("selects only classified failed files, never a resolved file", () => {
		const plan = planDaemonRestoreContinuation([previous()], "/memory/daemon.sock", successor, manifest);
		expect([...plan.failedFiles.keys()]).toEqual(["/memory/failed.jsonl"]);
		expect(plan.previouslyResolved).toBe(1);
	});
	it.each(["missing", "checkpoint", "pid", "start", "generation", "owner", "socket"])("refuses an unbound %s status", (change) => {
		const status = previous();
		if (change === "missing") delete status.manifestCreatedAt;
		if (change === "checkpoint") status.manifestCreatedAt = "different";
		if (change === "socket") status.socketPath = "/memory/other.sock";
		if (change === "pid") status.successor = { ...successor, pid: 789 };
		if (change === "start") status.successor = { ...successor, processStartId: "other" };
		if (change === "generation") status.successor = { ...successor, supervisorGeneration: "other" };
		if (change === "owner") status.successor = { ...successor, supervisorOwnerToken: "other" };
		expect(() => planDaemonRestoreContinuation([status], "/memory/daemon.sock", successor, manifest)).toThrow("not bound");
	});
	it("refuses the latest incomplete result rather than reusing an older complete result", () => {
		const incomplete = { ...previous(), requestId: "latest", phase: "restoring" as const,
			startedAt: "2026-01-01T00:02:00.000Z", updatedAt: "2026-01-01T00:02:01.000Z",
			counts: { total: 2, restored: 1, resumed: 0, failed: 0 }, failures: [] };
		expect(() => planDaemonRestoreContinuation([previous(), incomplete], "/memory/daemon.sock", successor, manifest)).toThrow("incomplete per-session");
	});
	it("does not let an informational mirror authorize restore", () => {
		const mirror = { ...previous(), successor: undefined, manifestCreatedAt: undefined };
		expect(() => planDaemonRestoreContinuation([mirror], "/memory/daemon.sock", successor, manifest)).toThrow("not bound");
	});
});
