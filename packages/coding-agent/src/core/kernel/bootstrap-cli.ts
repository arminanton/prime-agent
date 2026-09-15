import { ensureKernelPython, getKernelVenvDir, resolveRuntimeIdentity } from "./bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Deploy-time prebuild: build (or reuse) the kernel venv for the resolved runtime
// identity, publish it, and print what was resolved. Exits non-zero on any failure so a
// deploy step can gate on it. Only the venv family named by PRIME_AGENT_KERNEL_VENV (or
// the default location when it is unset) is ever touched.
try {
	const target = process.env.PRIME_AGENT_KERNEL_VENV;
	if (target) {
		console.log(`kernel venv target: ${target}`);
	} else {
		console.warn(
			"PRIME_AGENT_KERNEL_VENV is not set; bootstrapping the default kernel venv location. " +
				"Set PRIME_AGENT_KERNEL_VENV to prebuild a specific per-checkout venv at deploy time.",
		);
	}
	const identity = await resolveRuntimeIdentity();
	console.log(`runtime identity: ${identity}`);
	const python = await ensureKernelPython();
	console.log(`kernel venv: ${getKernelVenvDir()}`);
	console.log(`kernel python: ${python}`);
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
