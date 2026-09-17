import { ensureKernelPython } from "./bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

try {
	// Runtime sessions must not rebuild just because this variable was inherited.
	const forceRebuild = process.env.PRIME_AGENT_KERNEL_VENV_FORCE_REBUILD === "1";
	if (forceRebuild && process.env.PRIME_AGENT_KERNEL_PYTHON) {
		throw new Error("Unset PRIME_AGENT_KERNEL_PYTHON before rebuilding the kernel venv.");
	}
	const python = await ensureKernelPython({ forceRebuild });
	console.log(`kernel python: ${python}`);
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
