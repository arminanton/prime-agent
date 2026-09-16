import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { VERSION } from "../../config.js";
import type { DaemonRuntimeIdentity } from "./daemon-protocol.js";

declare const __PI_BUILD_ID__: string | undefined;

export const PRIME_AGENT_BUILD_ID_ENV = "PRIME_AGENT_BUILD_ID";
export const PRIME_AGENT_LAUNCHER_PATH_ENV = "PRIME_AGENT_LAUNCHER_PATH";

function bundledBuildId(): string | undefined {
	return typeof __PI_BUILD_ID__ === "undefined" ? undefined : __PI_BUILD_ID__;
}

export function getDaemonRuntimeIdentity(environment: NodeJS.ProcessEnv = process.env): DaemonRuntimeIdentity {
	const entrypoint = process.argv[1];
	const launcher = environment[PRIME_AGENT_LAUNCHER_PATH_ENV];
	return {
		buildId: environment[PRIME_AGENT_BUILD_ID_ENV] ?? bundledBuildId() ?? `release-${VERSION}`,
		executablePath: resolve(process.execPath),
		...(entrypoint ? { entrypointPath: resolve(entrypoint) } : {}),
		...(launcher ? { launcherPath: resolve(launcher) } : {}),
	};
}

export const DAEMON_ADMISSION_TICKET_ENV = "PRIME_AGENT_INTERNAL_DAEMON_ADMISSION_TICKET";

export interface DaemonReplacementIdentity {
	buildId: string;
	entrypointRealPath: string;
}

export function getDaemonReplacementIdentity(): DaemonReplacementIdentity {
	const runtime = getDaemonRuntimeIdentity();
	if (!runtime.buildId.trim() || !runtime.entrypointPath) throw new Error("Replacement target is missing its build or entrypoint identity");
	return { buildId: runtime.buildId, entrypointRealPath: realpathSync(runtime.entrypointPath) };
}

export function matchesDaemonReplacementIdentity(runtime: DaemonRuntimeIdentity | undefined, expected: DaemonReplacementIdentity): boolean {
	if (!runtime?.entrypointPath || runtime.buildId !== expected.buildId) return false;
	try { return realpathSync(runtime.entrypointPath) === expected.entrypointRealPath; }
	catch { return false; }
}
