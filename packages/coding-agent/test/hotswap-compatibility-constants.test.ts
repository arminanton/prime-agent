import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION } from "../src/core/session-manager.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID, DAEMON_UPDATE_RESTART_FORMAT_VERSION } from "../src/modes/daemon/daemon-protocol.js";

// Values verified from 08a008be4266047d548766755f79f682eda9ef47.
// This bridge intentionally changes no public wire, checkpoint, owner or session version.
describe("hot-swap bridge compatibility pin", () => {
	it("keeps the base protocol, schema, checkpoint and session versions", () => {
		expect({ DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID, DAEMON_UPDATE_RESTART_FORMAT_VERSION, CURRENT_SESSION_VERSION }).toEqual({
			DAEMON_PROTOCOL_VERSION: 7,
			DAEMON_SCHEMA_ID: "protocol-7-schema-29-f50bed649543",
			DAEMON_UPDATE_RESTART_FORMAT_VERSION: 1,
			CURRENT_SESSION_VERSION: 3,
		});
	});
	it("keeps the private owner record version while extending only local annotations", () => {
		const ownership = readFileSync(new URL("../src/modes/daemon/daemon-supervisor-ownership.ts", import.meta.url), "utf8");
		expect(ownership.match(/\bconst OWNER_VERSION = (\d+);/)?.[1]).toBe("1");
	});
});
