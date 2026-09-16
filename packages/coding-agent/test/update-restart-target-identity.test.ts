import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.js";
import { DAEMON_PROTOCOL_INFO, DAEMON_SCHEMA_ID } from "../src/modes/daemon/daemon-protocol.js";
import type { DaemonHello } from "../src/modes/daemon/daemon-client.js";
import { validateReplacementDaemon } from "../src/package-manager-cli.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("replacement build and physical slot identity", () => {
	it("accepts a realpath alias but rejects another build, slot, or missing runtime", () => {
		const root = mkdtempSync(join(tmpdir(), "target-identity-")); roots.push(root);
		const target = join(root, "target.js"); const alias = join(root, "alias.js"); const foreign = join(root, "foreign.js");
		writeFileSync(target, "// target"); writeFileSync(foreign, "// foreign"); symlinkSync(target, alias);
		const socketPath = join(root, "daemon.sock");
		const hello = { type: "daemon_hello", protocol: DAEMON_PROTOCOL_INFO, schemaId: DAEMON_SCHEMA_ID, appVersion: VERSION,
			supervisorPid: 123, supervisorProcessStartId: "start", supervisorGeneration: "new", supervisorOwnerToken: "owner", supervisorSocketPath: socketPath,
			runtime: { buildId: "target-build", executablePath: "/memory/node", entrypointPath: alias } } as DaemonHello;
		const expected = { buildId: "target-build", entrypointRealPath: realpathSync(target) };
		expect(validateReplacementDaemon(socketPath, hello, undefined, expected)).toMatchObject({ pid: 123 });
		for (const runtime of [undefined, { ...hello.runtime!, buildId: "other" }, { ...hello.runtime!, entrypointPath: foreign }, { ...hello.runtime!, entrypointPath: join(root, "missing") }]) {
			expect(() => validateReplacementDaemon(socketPath, { ...hello, runtime }, undefined, expected)).toThrow("expected build");
		}
	});
});
