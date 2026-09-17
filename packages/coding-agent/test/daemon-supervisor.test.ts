import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClosingReason } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";

describe("DaemonSupervisor", () => {
	it.each([
		["prepared", false, "shutdown"],
		["prepared", true, undefined],
		[undefined, true, "shutdown"],
		["draining", false, "shutdown"],
		["fencing", false, "shutdown"],
	] as const)("stops workers from %s (force=%s, reason=%s)", async (phase, force, reason) => {
		const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-stop-"));
		const socket = new PassThrough();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("test exit");
		});
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("worker has exited"), { code: "ESRCH" });
		});
		try {
			const socketPath = join(directory, "daemon.sock");
			const supervisor = new DaemonSupervisor(socketPath, {
				defaultSessionConfig: { agentDir: directory, cwd: directory },
				descriptorDir: directory,
			});
			const descriptorPath = join(directory, "worker.json");
			const descriptor: DaemonWorkerDescriptor = {
				version: 2,
				workerId: "worker",
				pid: 123,
				socketPath: join(directory, "worker.sock"),
				supervisorSocketPath: socketPath,
				recoveryJournalPath: join(directory, "journal.jsonl"),
				authenticationToken: "test-token",
				rootActiveSessionId: "active",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				lifecycle: "ready",
				createCommand: { type: "create" },
				consecutiveFailures: 0,
			};
			const commands: string[] = [];
			const request = async (command: { type: string }) => {
				commands.push(command.type);
			};
			(Reflect.get(supervisor, "workers") as Map<string, unknown>).set("worker", {
				descriptor,
				descriptorPath,
				stopRevision: 0,
				client: { request, requestWorker: request, close: () => {} },
				transcriptCaches: new Map(),
				snapshotCache: new Map(),
				summaries: new Map(),
			});
			(Reflect.get(supervisor, "clients") as Set<unknown>).add({ socket, detachInput: () => {} });
			Reflect.set(supervisor, "updateRestartPhase", phase);
			const shutdown = Reflect.get(supervisor, "shutdown") as (
				code: number,
				stopWorkers: boolean,
				relaunch: boolean,
				force: boolean,
				reason?: DaemonClosingReason,
			) => Promise<never>;
			await expect(shutdown.call(supervisor, 0, true, false, force, reason)).rejects.toThrow("test exit");
			const prepared = phase === "prepared";
			expect(JSON.parse(socket.read().toString())).toEqual({
				type: "daemon_closing",
				reason: prepared ? "update" : "shutdown",
			});
			expect(commands).toEqual([prepared ? "shutdown" : "worker_archive_and_shutdown"]);
			expect(existsSync(descriptorPath)).toBe(prepared);
			if (prepared) {
				const saved = JSON.parse(readFileSync(descriptorPath, "utf8")) as DaemonWorkerDescriptor;
				expect(saved.lifecycle).toBe("recovering");
				expect(saved.stopRequestedAt).toBeUndefined();
				expect(saved.archiveOnStop).toBeUndefined();
			}
		} finally {
			socket.destroy();
			exit.mockRestore();
			kill.mockRestore();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
