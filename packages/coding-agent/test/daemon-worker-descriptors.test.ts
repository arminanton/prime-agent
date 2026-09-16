import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const processes = vi.hoisted(() => new Map<number, string | undefined>());
vi.mock("../src/utils/child-process.js", async (original) => ({ ...await original<typeof import("../src/utils/child-process.js")>(),
	isProcessAlive: vi.fn((pid: number) => processes.has(pid)) }));
vi.mock("../src/core/session-lease.js", async (original) => ({ ...await original<typeof import("../src/core/session-lease.js")>(),
	getProcessStartId: vi.fn((pid: number) => processes.get(pid)) }));
import { defaultWorkerDescriptorDir, scanLiveWorkerProcesses } from "../src/modes/daemon/daemon-worker-descriptors.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); processes.clear(); });

describe("durable worker process scan", () => {
	it("keeps only scoped live/current or unknown identities and skips corrupt entries", () => {
		const root = mkdtempSync(join(tmpdir(), "worker-scan-")); roots.push(root);
		const socketPath = join(root, "daemon.sock"); const directory = defaultWorkerDescriptorDir(root, socketPath);
		mkdirSync(directory, { recursive: true });
		const base = { version: 2, supervisorSocketPath: socketPath, workerId: "worker", pid: 1,
			processStartId: "start", socketPath: join(root, "worker.sock"), rootActiveSessionId: "root",
			authenticationToken: "test", createdAt: "test", updatedAt: "test", lifecycle: "recovering", consecutiveFailures: 0,
			createCommand: { type: "create" } };
		const write = (name: string, extra: object) => writeFileSync(join(directory, name + ".json"), JSON.stringify({ ...base, ...extra }));
		processes.set(1, "start"); processes.set(2, "new-start"); processes.set(3, undefined); processes.set(4, "known");
		write("current", {}); write("reused", { pid: 2 }); write("unknown", { pid: 3 });
		write("no-identity", { pid: 4, processStartId: undefined }); write("dead", { pid: 5 });
		write("other-socket", { supervisorSocketPath: "/memory/other.sock" }); write("invalid", { createCommand: null });
		writeFileSync(join(directory, "broken.json"), "{"); writeFileSync(join(directory, "supervisor-config"), "{}");
		const live = scanLiveWorkerProcesses(root, socketPath);
		expect(live.map((v) => [v.pid, v.identity])).toEqual([[1, "current"], [4, "unknown"], [3, "unknown"]]);
		expect(live.every((v) => v.rootActiveSessionId === "root")).toBe(true);
	});
});
