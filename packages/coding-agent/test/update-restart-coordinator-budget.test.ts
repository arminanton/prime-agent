import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock("proper-lockfile", () => ({ default: { lock: state.lock } }));
import { acquireDaemonUpdateRestartCoordinator } from "../src/cli/daemon-update-restart.js";
const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); state.lock.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("coordinator exclusion deadline", () => {
	it("releases a late guard without publishing ownership after the deadline", async () => {
		vi.useFakeTimers(); const root = mkdtempSync(join(tmpdir(), "coordinator-budget-")); roots.push(root);
		const release = vi.fn(async () => {}); let finish!: (release: () => Promise<void>) => void;
		state.lock.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
		const acquiring = acquireDaemonUpdateRestartCoordinator({ requestId: "test", socketPath: "/memory/daemon.sock", statusPath: join(root, "status.json"), registryDir: root });
		const failed = expect(acquiring).rejects.toThrow("coordinator registry guard acquisition exceeded");
		await vi.advanceTimersByTimeAsync(6000); await failed;
		finish(release); await vi.advanceTimersByTimeAsync(0);
		expect(release).toHaveBeenCalledTimes(1); expect(readdirSync(root)).toEqual([]);
	});
});
