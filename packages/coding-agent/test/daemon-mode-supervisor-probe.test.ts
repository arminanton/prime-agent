import { describe, expect, it } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

// Supervisor-replacement probe hardening (R4 sibling). A worker must not spawn a
// replacement daemon or self-exit on a single transient socket-probe failure, nor while
// the supervisor still owns its registry entry with a live process. The probe->decision
// state machine is exercised directly on a partial daemon instance.

interface ProbeHandle {
	supervisorProbeFailures: number;
	lastKnownSupervisorClaim?: unknown;
	evaluateSupervisorProbe(probeConnected: boolean, ownershipAlive: boolean): string;
	isSupervisorOwnershipAlive(): Promise<boolean>;
}

function makeDaemon(): ProbeHandle {
	return Object.assign(Object.create(AgentDaemon.prototype) as object, {
		supervisorProbeFailures: 0,
		lastKnownSupervisorClaim: undefined,
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
});
