import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// spawnHidden is mocked so a guard regression cannot spawn a real replacement daemon in a unit
// test, and so the "returns early" assertion can check that no spawn was attempted.
const { spawnHiddenMock } = vi.hoisted(() => ({ spawnHiddenMock: vi.fn() }));
vi.mock("../src/utils/child-process.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/child-process.js")>();
	return { ...actual, spawnHidden: spawnHiddenMock };
});

import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

// Supervisor-replacement probe hardening (R4 sibling). A worker must not spawn a
// replacement daemon or self-exit on a single transient socket-probe failure, nor while
// the supervisor still owns its registry entry with a live process. The probe->decision
// state machine is exercised directly on a partial daemon instance.

interface ProbeHandle {
	supervisorProbeFailures: number;
	supervisorLaunchInProgress: boolean;
	shuttingDown: boolean;
	lastKnownSupervisorClaim?: unknown;
	evaluateSupervisorProbe(probeConnected: boolean, ownershipAlive: boolean): string;
	isSupervisorOwnershipAlive(): Promise<boolean>;
	canConnectToSupervisor(socketPath: string): Promise<boolean>;
	launchReplacementSupervisor(socketPath: string): Promise<void>;
}

function makeDaemon(overrides: Partial<ProbeHandle> = {}): ProbeHandle {
	return Object.assign(Object.create(AgentDaemon.prototype) as object, {
		supervisorProbeFailures: 0,
		supervisorLaunchInProgress: false,
		shuttingDown: false,
		lastKnownSupervisorClaim: undefined,
		log: () => {},
		...overrides,
	}) as unknown as ProbeHandle;
}

describe("supervisor probe/replacement hardening (R4 sibling)", () => {
	it("treats one or two consecutive failures as wait; only three-plus is lost", () => {
		const daemon = makeDaemon();
		expect(daemon.evaluateSupervisorProbe(false, false)).toBe("wait");
		expect(daemon.evaluateSupervisorProbe(false, false)).toBe("wait");
		expect(daemon.evaluateSupervisorProbe(false, false)).toBe("lost");
		expect(daemon.evaluateSupervisorProbe(false, false)).toBe("lost");
	});

	it("resets the consecutive-failure counter on a successful probe", () => {
		const daemon = makeDaemon();
		daemon.evaluateSupervisorProbe(false, false);
		daemon.evaluateSupervisorProbe(false, false);
		expect(daemon.evaluateSupervisorProbe(true, false)).toBe("connected");
		expect(daemon.supervisorProbeFailures).toBe(0);
		// Three fresh failures are required again after a reset.
		expect(daemon.evaluateSupervisorProbe(false, false)).toBe("wait");
	});

	it("never reports lost while the ownership record is alive, even at the failure brink", () => {
		const daemon = makeDaemon();
		daemon.evaluateSupervisorProbe(false, false);
		daemon.evaluateSupervisorProbe(false, false);
		expect(daemon.evaluateSupervisorProbe(false, true)).toBe("owner-alive");
		expect(daemon.supervisorProbeFailures).toBe(0);
		// The next failure starts a fresh count rather than immediately going lost.
		expect(daemon.evaluateSupervisorProbe(false, false)).toBe("wait");
	});

	it("reports ownership not alive when no supervisor has authenticated yet", async () => {
		const daemon = makeDaemon();
		await expect(daemon.isSupervisorOwnershipAlive()).resolves.toBe(false);
	});

	it("launchReplacementSupervisor returns early without spawning when the ownership record is alive", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-replacement-supervisor-"));
		try {
			spawnHiddenMock.mockClear();
			const socketPath = join(tempDir, "daemon.sock");
			// The socket probe fails (so we pass the connect guard), but the ownership record still
			// names a live supervisor process: a second daemon must NOT be spawned on top of it.
			const canConnect = vi.fn(async () => false);
			const ownershipAlive = vi.fn(async () => true);
			const daemon = makeDaemon({
				canConnectToSupervisor: canConnect,
				isSupervisorOwnershipAlive: ownershipAlive,
			});

			await daemon.launchReplacementSupervisor(socketPath);

			expect(canConnect).toHaveBeenCalled();
			expect(ownershipAlive).toHaveBeenCalled();
			// The early return happens before any subprocess launch.
			expect(spawnHiddenMock).not.toHaveBeenCalled();
			// The in-progress guard is cleared for the next attempt.
			expect(daemon.supervisorLaunchInProgress).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
