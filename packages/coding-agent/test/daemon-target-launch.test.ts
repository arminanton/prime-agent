import type * as ChildProcessTypes from "../src/utils/child-process.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ spawned: false, launches: [] as Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> }));
vi.mock("../src/utils/child-process.js", async (original) => ({ ...await original<typeof ChildProcessTypes>(),
	spawnHidden: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
		state.spawned = true; state.launches.push({ command, args, env: options.env }); return Object.assign(new EventEmitter(), { unref: vi.fn() });
	} }));
vi.mock("../src/modes/daemon/daemon-client.js", () => ({ DaemonClient: class {
	async connect() { if (!state.spawned) throw new Error("not yet started"); }
	async waitForHello() { return { protocol: DAEMON_PROTOCOL_INFO, schemaId: DAEMON_SCHEMA_ID, appVersion: VERSION }; }
	close() {}
} }));
import { ensureInteractiveDaemonRunning } from "../src/cli/daemon-launch.js";
import { VERSION } from "../src/config.js";
import { DAEMON_PROTOCOL_INFO, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";
import { DAEMON_ADMISSION_TICKET_ENV } from "../src/modes/daemon/daemon-runtime-identity.js";
afterEach(() => { state.spawned = false; state.launches.length = 0; delete process.env[DAEMON_ADMISSION_TICKET_ENV]; });
describe("pinned target launcher", () => {
	it("passes the ticket only to the pinned supervisor and never in argv", async () => {
		await ensureInteractiveDaemonRunning("/memory/target.sock", undefined, { target: { buildId: "target", entrypointRealPath: "/memory/pinned-target.js" }, admissionTicket: "private-ticket" });
		expect(state.launches).toHaveLength(1);
		expect(state.launches[0]!.args).toContain("/memory/pinned-target.js");
		expect(state.launches[0]!.env[DAEMON_ADMISSION_TICKET_ENV]).toBe("private-ticket");
		expect(state.launches[0]!.args).not.toContain("private-ticket");
	});
	it("an ordinary launcher cannot forward an inherited target ticket", async () => {
		process.env[DAEMON_ADMISSION_TICKET_ENV] = "stale-ticket";
		await ensureInteractiveDaemonRunning("/memory/ordinary.sock");
		expect(state.launches[0]!.env[DAEMON_ADMISSION_TICKET_ENV]).toBeUndefined();
	});
});
