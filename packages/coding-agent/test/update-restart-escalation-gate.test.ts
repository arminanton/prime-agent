import { afterEach, describe, expect, it, vi } from "vitest";
import { escalateExactProcess, evaluatePredecessorEscalationGate, type EscalationGateInput, type ExactProcessOperations } from "../src/cli/daemon-update-retirement.js";
import { UPDATE_RESTART_PREPARE_RPC_TIMEOUT_MS } from "../src/package-manager-cli.js";
import { UPDATE_RESTART_PREPARE_DEADLINE_MS, UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS } from "../src/modes/daemon/daemon-supervisor.js";
const valid = (): EscalationGateInput => ({
	fence: { pid: 123, processStartId: "start", ownerToken: "owner", supervisorGeneration: "generation", socketPath: "/memory/daemon.sock" },
	predecessor: { pid: 123, processStartId: "start", supervisorOwnerToken: "owner", supervisorGeneration: "generation" },
	provenance: "prepare_rpc", shutdownAccepted: true, socketConnectable: false, socketPath: "/memory/daemon.sock", disabledByEnv: false,
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("predecessor escalation gate", () => {
	it("covers the complete pre-COMMIT and COMMIT budgets plus retirement slack", () => {
		expect(UPDATE_RESTART_PREPARE_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(UPDATE_RESTART_PREPARE_DEADLINE_MS + UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS + 15_000);
	});
	it.each([
		["G1", { provenance: undefined }], ["G1", { provenance: "pending_manifest_idle_daemon" }],
		["G2", { shutdownAccepted: false }], ["G3", { socketConnectable: true }], ["G4", { predecessor: undefined }],
	] as const)("fails closed when %s is not proved", (gate, override) => {
		expect(evaluatePredecessorEscalationGate({ ...valid(), ...override })).toMatchObject({ allowed: false, reason: expect.stringContaining(gate) });
	});
	it("checks every predecessor identity field and the socket scope", () => {
		for (const field of ["pid", "processStartId", "supervisorOwnerToken", "supervisorGeneration"] as const) {
			const input = valid(); input.predecessor = { ...input.predecessor!, [field]: field === "pid" ? 456 : "other" };
			expect(evaluatePredecessorEscalationGate(input)).toMatchObject({ allowed: false });
		}
		expect(evaluatePredecessorEscalationGate({ ...valid(), socketPath: "/memory/other.sock" })).toMatchObject({ allowed: false });
		expect(evaluatePredecessorEscalationGate({ ...valid(), disabledByEnv: true })).toMatchObject({ allowed: false });
		expect(evaluatePredecessorEscalationGate(valid())).toEqual({ allowed: true });
	});
});
describe("exact process escalation", () => {
	it("uses TERM then KILL on one positive pid and confirms death", async () => {
		vi.useFakeTimers(); let alive = true;
		const signal = vi.fn((_pid: number, signal: string) => { if (signal === "SIGKILL") alive = false; });
		const operations: ExactProcessOperations = { isAlive: () => alive, startId: () => "start", signal };
		const work = escalateExactProcess({ pid: 123, processStartId: "start" }, { operations });
		await vi.advanceTimersByTimeAsync(5000);
		expect(await work).toMatchObject({ signals: ["SIGTERM", "SIGKILL"], outcome: "dead" });
		expect(signal.mock.calls).toEqual([[123, "SIGTERM"], [123, "SIGKILL"]]);
	});
	it("never signals a reused pid, zombie, or unobservable identity", async () => {
		for (const [alive, startId, outcome] of [[false, "start", "dead"], [true, "other", "dead"], [true, undefined, "identity_unknown"]] as const) {
			const signal = vi.fn();
			expect(await escalateExactProcess({ pid: 123, processStartId: "start" }, { operations: { isAlive: () => alive, startId: () => startId, signal } })).toMatchObject({ outcome });
			expect(signal).not.toHaveBeenCalled();
		}
	});
	it("rechecks identity after admission renewal and before each signal", async () => {
		let startId = "start"; const signal = vi.fn();
		const result = await escalateExactProcess({ pid: 123, processStartId: "start" }, { operations: { isAlive: () => true, startId: () => startId, signal },
			assertAdmission: async () => { startId = "reused"; } });
		expect(result.outcome).toBe("dead"); expect(signal).not.toHaveBeenCalled();
	});
	it("records an uninterruptible survivor after SIGKILL and never claims it dead", async () => {
		vi.useFakeTimers(); const signal = vi.fn();
		const work = escalateExactProcess({ pid: 123, processStartId: "start" }, { operations: { isAlive: () => true, startId: () => "start", signal } });
		await vi.advanceTimersByTimeAsync(5000);
		expect(await work).toMatchObject({ outcome: "survived_sigkill", signals: ["SIGTERM", "SIGKILL"] });
	});
	it("surfaces EPERM as blocked and rejects process-group pids", async () => {
		const signal = vi.fn(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
		const operations = { isAlive: () => true, startId: () => "start", signal };
		await expect(escalateExactProcess({ pid: 123, processStartId: "start" }, { operations })).rejects.toThrow("blocked:");
		await expect(escalateExactProcess({ pid: -123, processStartId: "start" }, { operations })).rejects.toThrow("positive exact pid");
	});
});
