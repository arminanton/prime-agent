import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRuntimeBootstrap } from "../src/cli/runtime-bootstrap.js";
import { runKernelPrebuild } from "../src/core/kernel/bootstrap.js";

// M8: the public `--prime-agent-bootstrap` flag must WARN and prebuild the DEFAULT venv family when
// PRIME_AGENT_KERNEL_VENV is unset (the native installer + worker.py call it with no caller venv),
// and be strict (requireNamedVenv) only when PRIME_AGENT_KERNEL_VENV_REQUIRED=1 (the deploy runbook
// sets it). Here we mock the heavy deps and assert the requireNamedVenv wiring; the actual
// default-family build + exit 0 is covered in kernel-bootstrap.test.ts.

vi.mock("../src/utils/tools-manager.js", () => ({ ensureTool: vi.fn(async () => "") }));
vi.mock("../src/core/kernel/bootstrap.js", () => ({ runKernelPrebuild: vi.fn(async () => {}) }));

const REQUIRED = "PRIME_AGENT_KERNEL_VENV_REQUIRED";

describe("runRuntimeBootstrap public-flag wiring (M8)", () => {
	let original: string | undefined;

	beforeEach(() => {
		original = process.env[REQUIRED];
		vi.clearAllMocks();
	});

	afterEach(() => {
		if (original === undefined) delete process.env[REQUIRED];
		else process.env[REQUIRED] = original;
	});

	it("prebuilds the DEFAULT family (requireNamedVenv false) when PRIME_AGENT_KERNEL_VENV_REQUIRED is unset", async () => {
		delete process.env[REQUIRED];

		await runRuntimeBootstrap();

		expect(runKernelPrebuild).toHaveBeenCalledTimes(1);
		expect(runKernelPrebuild).toHaveBeenCalledWith({ requireNamedVenv: false });
	});

	it("is strict (requireNamedVenv true) only when PRIME_AGENT_KERNEL_VENV_REQUIRED=1", async () => {
		process.env[REQUIRED] = "1";

		await runRuntimeBootstrap();

		expect(runKernelPrebuild).toHaveBeenCalledWith({ requireNamedVenv: true });
	});
});
