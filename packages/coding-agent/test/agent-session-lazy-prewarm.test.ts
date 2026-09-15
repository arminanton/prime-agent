import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";

// Lazy kernel prewarm (A.5). A daemon-hydrated passive session (e.g. a woken subagent
// child) must not eagerly start a Python kernel and restore its pickle at build time; it
// defers to the first actual ipython use. Interactive/main agents still prewarm. The gate
// decision is exercised directly on a partial session instance.

interface PrewarmHandle {
	_prewarmIpythonKernel: boolean;
	_shouldEagerPrewarmKernel(hasSnapshot: boolean): boolean;
}

function makeSession(prewarm: boolean): PrewarmHandle {
	return Object.assign(Object.create(AgentSession.prototype) as object, {
		_prewarmIpythonKernel: prewarm,
	}) as unknown as PrewarmHandle;
}

const ENV = "PRIME_AGENT_EAGER_KERNEL_PREWARM_ON_HYDRATE";

describe("lazy kernel prewarm (A.5)", () => {
	afterEach(() => {
		delete process.env[ENV];
	});

	it("interactive/main agents prewarm regardless of snapshot or env", () => {
		const session = makeSession(true);
		expect(session._shouldEagerPrewarmKernel(false)).toBe(true);
		expect(session._shouldEagerPrewarmKernel(true)).toBe(true);
	});

	it("a passive snapshot-bearing session defers by default (no eager kernel start)", () => {
		const session = makeSession(false);
		expect(session._shouldEagerPrewarmKernel(true)).toBe(false);
		expect(session._shouldEagerPrewarmKernel(false)).toBe(false);
	});

	it("the env switch restores eager on-hydrate prewarm for a snapshot-bearing session", () => {
		const session = makeSession(false);
		process.env[ENV] = "1";
		expect(session._shouldEagerPrewarmKernel(true)).toBe(true);
		// There is still nothing to prewarm without a snapshot.
		expect(session._shouldEagerPrewarmKernel(false)).toBe(false);
	});
});
