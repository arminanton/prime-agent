import type * as ChildProcessTypes from "../src/utils/child-process.js";
import type * as SessionLeaseTypes from "../src/core/session-lease.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("proper-lockfile", () => ({ default: { lock: vi.fn(async () => vi.fn(async () => {})) } }));
vi.mock("../src/utils/child-process.js", async (original) => ({ ...await original<typeof ChildProcessTypes>(), isProcessAlive: () => true }));
vi.mock("../src/core/session-lease.js", async (original) => ({ ...await original<typeof SessionLeaseTypes>(), getProcessStartId: () => "start" }));
import { acquireDaemonShutdownAdmission, acquireDaemonSupervisorOwnership, isDaemonShutdownAdmissionActive, persistDaemonStartupFenceFromOwner, waitForDaemonStartupFence } from "../src/modes/daemon/daemon-supervisor-ownership.js";
import { DAEMON_ADMISSION_TICKET_ENV, getDaemonReplacementIdentity } from "../src/modes/daemon/daemon-runtime-identity.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
const roots: string[] = [];
const originalEntrypoint = process.argv[1];
const originalBuild = process.env.PRIME_AGENT_BUILD_ID;
const registryEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const originalRegistry = process.env[registryEnv];
function paths() {
	const root = mkdtempSync(join(tmpdir(), "target-ticket-")); roots.push(root);
	const entrypoint = join(root, "target.js"); writeFileSync(entrypoint, "// never executed");
	process.argv[1] = entrypoint; process.env.PRIME_AGENT_BUILD_ID = "target-build";
	process.env[registryEnv] = join(root, "registry");
	const agentDir = join(root, "agent"); const descriptorDir = join(agentDir, "workers"); mkdirSync(descriptorDir, { recursive: true });
	return { root, agentDir, descriptorDir, socketPath: join(root, "daemon.sock"), registryDir: process.env[registryEnv]! };
}
afterEach(() => {
	process.argv[1] = originalEntrypoint;
	if (originalBuild === undefined) delete process.env.PRIME_AGENT_BUILD_ID; else process.env.PRIME_AGENT_BUILD_ID = originalBuild;
	if (originalRegistry === undefined) delete process.env[registryEnv]; else process.env[registryEnv] = originalRegistry;
	delete process.env[DAEMON_ADMISSION_TICKET_ENV]; vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("target admission ticket", () => {
	it("blocks a byte-identical ticketless launcher, admits only the target, and keeps live-owner exclusion", async () => {
		const scope = paths(); const admission = await acquireDaemonShutdownAdmission();
		const ticket = await admission.grantTargetTicket({ ...getDaemonReplacementIdentity(), ...scope });
		const base = { ...scope, appVersion: "test", generation: "target" };
		try {
			await expect(acquireDaemonSupervisorOwnership(base)).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
			process.env.PRIME_AGENT_BUILD_ID = "old-build";
			await expect(acquireDaemonSupervisorOwnership({ ...base, admissionTicket: ticket })).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
			process.env.PRIME_AGENT_BUILD_ID = "target-build";
			const owner = await acquireDaemonSupervisorOwnership({ ...base, admissionTicket: ticket });
			try {
				expect(await isDaemonShutdownAdmissionActive()).toBe(true); // Worker/old-reader behavior.
				expect(await isDaemonShutdownAdmissionActive({ exceptOwner: owner })).toBe(false);
				await expect(acquireDaemonSupervisorOwnership({ ...base, generation: "duplicate", admissionTicket: ticket })).rejects.toMatchObject({ code: "daemon_supervisor_already_running" });
				await admission.assertTargetClaim({ supervisorGeneration: owner.record.generation, supervisorOwnerToken: owner.record.token,
					supervisorPid: owner.record.pid, supervisorProcessStartId: owner.record.processStartId, supervisorSocketPath: owner.record.socketPath });
				await persistDaemonStartupFenceFromOwner(scope.socketPath, { supervisorGeneration: owner.record.generation,
					supervisorOwnerToken: owner.record.token, supervisorPid: owner.record.pid,
					supervisorProcessStartId: owner.record.processStartId, supervisorSocketPath: owner.record.socketPath }, scope.registryDir);
				await expect(waitForDaemonStartupFence(scope.socketPath, 0, scope.registryDir)).rejects.toMatchObject({ name: "DaemonStartupFenceTimeoutError" });
				const recorded = JSON.parse(readFileSync(join(scope.registryDir, "shutdown-admission.json"), "utf8"));
				expect(recorded.version).toBe(1); expect(recorded.targetTicket.token).toBe(ticket);
				// Real supervisor recovery entry uses the claimed exact-owner exception.
				const sup = Object.assign(Object.create(DaemonSupervisor.prototype), { ownership: owner, assertServingCurrentOwnership: async () => {} });
				await expect(sup.assertRecoveryAllowed()).resolves.toBeUndefined();
			} finally { await owner.release(); }
			const retry = await acquireDaemonSupervisorOwnership({ ...base, generation: "unscoped-retry", admissionTicket: ticket });
			await retry.release(); // Same ticket is reusable only after ordinary owner exclusion permits it.
		} finally { await admission.release(); }
	});

	it("a newer admission never inherits an older target's recovery exception", async () => {
		const scope = paths(); const first = await acquireDaemonShutdownAdmission();
		const ticket = await first.grantTargetTicket({ ...getDaemonReplacementIdentity(), ...scope });
		const owner = await acquireDaemonSupervisorOwnership({ ...scope, appVersion: "test", generation: "first-target", admissionTicket: ticket });
		await first.release();
		const second = await acquireDaemonShutdownAdmission();
		try {
			await second.grantTargetTicket({ ...getDaemonReplacementIdentity(), ...scope });
			expect(await isDaemonShutdownAdmissionActive({ exceptOwner: owner })).toBe(true);
			await expect(acquireDaemonSupervisorOwnership({ ...scope, appVersion: "test", generation: "stale-ticket", admissionTicket: ticket })).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
		} finally { await second.release(); await owner.release(); }
	});

	it("a ticket with no live admission uses ordinary owner acquisition", async () => {
		const scope = paths();
		const owner = await acquireDaemonSupervisorOwnership({ ...scope, appVersion: "test", generation: "no-admission", admissionTicket: "expired-ticket" });
		expect(owner.claimedAdmissionTicket).toBeUndefined(); await owner.release();
	});

	it("consumes the environment ticket before any startup child can inherit it", async () => {
		process.env[DAEMON_ADMISSION_TICKET_ENV] = "child-only-ticket";
		const sup = Object.assign(Object.create(DaemonSupervisor.prototype), { defaultSessionConfig: {}, log: vi.fn(), cleanupSupervisorResources: async () => {}, rejectReady: vi.fn() });
		await expect(sup.start()).rejects.toThrow("missing agentDir");
		expect(process.env[DAEMON_ADMISSION_TICKET_ENV]).toBeUndefined();
	});
});
