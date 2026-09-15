import { runKernelPrebuild } from "../core/kernel/bootstrap.js";
import { ensureTool } from "../utils/tools-manager.js";

// The public prebuild entrypoint: `prime-agent --prime-agent-bootstrap` routes here via cli-main.ts.
// It rejects a conflicting PRIME_AGENT_KERNEL_PYTHON override and prints the resolved runtime
// identity, kernel venv, and kernel python; cli-main.ts sets a non-zero exit code when it throws,
// so a deploy step can gate on it.
//
// The native installer (install.sh) and scripts/benchmarks/worker.py call this flag WITHOUT a
// caller venv variable, and a default-family prebuild is NON-destructive (A.2: generation GC is
// opt-in), so by default it WARNS and prebuilds the DEFAULT kernel venv family when
// PRIME_AGENT_KERNEL_VENV is unset (as bootstrap-cli.ts already does). Strictness (fail when it is
// unset, so a deploy only ever touches its named per-checkout family) is opt-in via
// PRIME_AGENT_KERNEL_VENV_REQUIRED=1, which the deploy runbook sets.
export async function runRuntimeBootstrap(): Promise<void> {
	await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	await runKernelPrebuild({ requireNamedVenv: process.env.PRIME_AGENT_KERNEL_VENV_REQUIRED === "1" });
}
