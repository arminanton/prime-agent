import { runKernelPrebuild } from "../core/kernel/bootstrap.js";
import { ensureTool } from "../utils/tools-manager.js";

// The real deploy prebuild entrypoint: `prime-agent --prime-agent-bootstrap` routes here via
// cli-main.ts. It requires PRIME_AGENT_KERNEL_VENV so a deploy only ever builds its named
// per-checkout venv family, rejects a conflicting PRIME_AGENT_KERNEL_PYTHON override, and prints
// the resolved runtime identity, kernel venv, and kernel python. cli-main.ts sets a non-zero
// exit code when this throws, so a deploy step can gate on it.
export async function runRuntimeBootstrap(): Promise<void> {
	await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	await runKernelPrebuild({ requireNamedVenv: true });
}
