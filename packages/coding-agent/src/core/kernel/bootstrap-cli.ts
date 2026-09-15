import { runKernelPrebuild } from "./bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Internal test/dev prebuild (package.json test:ci, scripts/setup-kernel-venv.sh). Builds (or
// reuses) the kernel venv for the resolved runtime identity, publishes it, and prints what was
// resolved. Exits non-zero on any failure so a step can gate on it. The default base is allowed
// here (a warning is printed); the public --prime-agent-bootstrap flag requires a named venv.
// Only the venv family named by PRIME_AGENT_KERNEL_VENV (or the default when unset) is touched.
try {
	await runKernelPrebuild();
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
