import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "../../config.js";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import { isProcessAlive, spawnHidden } from "../../utils/child-process.js";
import { tryAcquireDirLock } from "../../utils/dir-lock.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";

const BOOTSTRAP_SCHEMA = 9;
const PYTHON_VERSION = "3.11";
const RUNTIME_PACKAGE_NAME = "prime-agent-runtime";
const RUN_STDERR_TAIL_CHARS = 8_000;
// Serializes the kernel's user namespace so it can be revived across session
// resume. Internal-only; intentionally not surfaced to the model as an import.
const STATE_SNAPSHOT_REQUIREMENT = "dill";
const DEFAULT_RLM_EXTRA_PACKAGES = [
	{ uvArg: "requests", importName: "requests", promptLabel: "requests" },
	{ uvArg: "httpx", importName: "httpx", promptLabel: "httpx" },
	{ uvArg: "pyyaml", importName: "yaml", promptLabel: "yaml (PyYAML)" },
	{ uvArg: "tomli", importName: "tomli", promptLabel: "tomli" },
	{ uvArg: "python-dotenv", importName: "dotenv", promptLabel: "dotenv (python-dotenv)" },
	{ uvArg: "pandas", importName: "pandas", promptLabel: "pandas" },
	{ uvArg: "numpy", importName: "numpy", promptLabel: "numpy" },
	{ uvArg: "scipy", importName: "scipy", promptLabel: "scipy" },
	{ uvArg: "beautifulsoup4", importName: "bs4", promptLabel: "bs4 (Beautiful Soup)" },
	{ uvArg: "lxml", importName: "lxml", promptLabel: "lxml" },
	{ uvArg: "pydantic", importName: "pydantic", promptLabel: "pydantic" },
	{ uvArg: "tyro", importName: "tyro", promptLabel: "tyro" },
];
export const DEFAULT_RLM_EXTRA_UV_ARGS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.uvArg);
export const DEFAULT_RLM_EXTRA_IMPORT_NAMES = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.importName);
export const DEFAULT_RLM_EXTRA_IMPORT_LABELS = DEFAULT_RLM_EXTRA_PACKAGES.map((pkg) => pkg.promptLabel);
const WINDOWS_PATHEXT_DEFAULT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_SUPPORTED_EXECUTABLE_EXTENSIONS = new Set(
	WINDOWS_PATHEXT_DEFAULT.map((extension) => extension.toLowerCase()),
);

export interface BatchShimInvocation {
	args: string[];
	env: NodeJS.ProcessEnv;
}

/** Build a cmd.exe invocation without embedding user-controlled values in its command string. */
export function buildBatchShimInvocation(
	command: string,
	args: readonly string[],
	baseEnv: NodeJS.ProcessEnv,
	token = randomUUID().replaceAll("-", ""),
): BatchShimInvocation {
	if (!/^[A-Za-z0-9_]+$/.test(token)) {
		throw new Error("Windows batch shim token contains unsupported characters");
	}
	const values = [command, ...args];
	if (values.some((value) => /["\0\r\n]/.test(value))) {
		throw new Error("Windows batch shim paths and arguments cannot contain quotes, NUL, or line breaks");
	}
	const env = { ...baseEnv };
	const variables = values.map((value, index) => {
		const name = `PRIME_AGENT_BATCH_${token}_${index}`;
		env[name] = value;
		return `"%${name}%"`;
	});
	return {
		args: ["/d", "/v:off", "/s", "/c", `"${variables.join(" ")}"`],
		env,
	};
}

const UV_INSTALL_COMMAND = "curl -LsSf https://astral.sh/uv/install.sh | sh";
/** MCP discovery surface the kernel runtime must expose for /plugins work. */
const REQUIRED_MCP_DISCOVERY_METHODS = [
	"list_plugins",
	"search_plugins",
	"list_connections",
	"search_tools",
	"describe_tool",
];
const REQUIRED_HARNESS_METHODS = [
	"create_memory",
	"update_memory",
	"delete_memory",
	"create_skill",
	"update_skill",
	"delete_skill",
	"create_subagent",
	"update_subagent",
	"delete_subagent",
	"create_prompt_note",
	"update_prompt_note",
	"delete_prompt_note",
	"record_refinement",
];
export const RUNTIME_READY_CHECK = `import inspect; import rlm; from rlm import McpIntegration; import rlm.mcp as mcp; from rlm.harness import HarnessEntry; _harness_methods = ${JSON.stringify(REQUIRED_HARNESS_METHODS)}; assert callable(mcp.list_tools); assert callable(mcp.call_tool); assert all(callable(getattr(mcp, _m, None)) for _m in ${JSON.stringify(REQUIRED_MCP_DISCOVERY_METHODS)}), "rlm.mcp is missing MCP discovery methods (list_plugins, search_plugins, list_connections, search_tools, describe_tool); the kernel venv needs a current prime-agent-runtime"; assert callable(rlm.spawn); assert hasattr(rlm, 'rlm'); assert callable(rlm.rlm.spawn); assert inspect.signature(rlm.spawn).parameters['name'].default is inspect.Parameter.empty; assert not hasattr(rlm, 'run'); assert not hasattr(rlm.rlm, 'run'); assert callable(rlm.host_request); assert callable(rlm.find_models); assert callable(rlm.rlm.find_models); assert callable(rlm.create_session); assert callable(rlm.rlm.create_session); assert callable(rlm.progress_note); assert callable(rlm.rlm.progress_note); assert hasattr(rlm, 'harness'); assert hasattr(rlm, 'get_harness_state'); assert hasattr(rlm.rlm, 'harness'); assert hasattr(rlm.rlm, 'get_harness_state'); assert all(callable(getattr(_harness, _method, None)) for _harness in (rlm.harness, rlm.rlm.harness) for _method in _harness_methods); assert 'reference' in HarnessEntry.__dataclass_fields__; assert 'scope' in HarnessEntry.__dataclass_fields__; assert 'reference' in inspect.signature(rlm.harness.create_skill).parameters; assert 'reference' in inspect.signature(rlm.harness.update_skill).parameters; assert 'global_' in inspect.signature(rlm.harness.create_memory).parameters; assert 'global_' in inspect.signature(rlm.get_harness_state).parameters; assert not hasattr(rlm, 'background'); assert not hasattr(rlm.rlm, 'background'); from rlm.bash import BashHandle, BashResult; assert callable(rlm.bash); assert all(callable(getattr(BashHandle, _m, None)) for _m in ('tail', 'output', 'poll', 'kill')); assert {'exit_code', 'output', 'duration'} <= set(BashResult.__dataclass_fields__); import rlm.repl as _repl; assert callable(_repl.main); assert callable(_repl.emit); assert callable(_repl.host_request); assert callable(_repl.is_active); assert _repl.PROTOCOL_VERSION == 3; assert callable(rlm.emit); assert not hasattr(rlm, 'HOST_COMM_TARGET'); assert not hasattr(mcp, 'install_shutdown_hook')`;
const BOOTSTRAP_VERSION_FILE = ".bootstrap-version";
const BOOTSTRAP_LOCK_NAME = ".bootstrap.lock";
const BOOTSTRAP_LOCK_RETRY_MS = 100;
const BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS = 30_000;
// Generations and metadata are siblings of the legacy venv, never files inside it.
// Published generations remain available to running kernels; bootstrap never collects them.
const BOOTSTRAP_POINTER_SUFFIX = ".current";
const BOOTSTRAP_FAILED_SUFFIX = ".bootstrap-failed";
const BOOTSTRAP_GENERATION_HASH_LENGTH = 16;
const BOOTSTRAP_BACKOFF_BASE_MS = 60_000;
const BOOTSTRAP_BACKOFF_MAX_MS = 30 * 60_000;

let inFlightEnsureKernelPython: { key: string; promise: Promise<string> } | null = null;

export type KernelPythonSkill = PythonSkillRuntimeInfo;
export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
	pythonSkills?: readonly KernelPythonSkill[];
	onProgress?: KernelBootstrapProgressHandler;
	/** Build a fresh generation. Only the one-shot bootstrap CLI reads the environment switch. */
	forceRebuild?: boolean;
}

interface BootstrapPythonSkill {
	importName: string;
	packagePath: string;
	pyprojectPath: string;
	pyprojectHash: string;
}

interface BootstrapVersion {
	schema: number;
	runtime?: string;
	snapshot?: string;
	extraUvArgs?: string[];
	generation?: string;
	pythonSkills?: BootstrapPythonSkill[];
}

interface BootstrapPointer {
	current: string;
	previous?: string;
	updatedAt: number;
}

interface BootstrapFailureMarker {
	identity: string;
	attempt: number;
	nextRetryAt: number;
	lastError?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function expandHome(filePath: string): string {
	if (filePath === "~") return os.homedir();
	if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
	return filePath;
}

function fileContentHash(filePath: string): string {
	try {
		return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
	} catch {
		return "unreadable";
	}
}

function normalizePythonSkills(pythonSkills: readonly KernelPythonSkill[] | undefined): BootstrapPythonSkill[] {
	const byKey = new Map<string, BootstrapPythonSkill>();
	const addSkill = (skill: Pick<KernelPythonSkill, "importName" | "packagePath" | "pyprojectPath">): void => {
		const packagePath = path.resolve(skill.packagePath);
		const pyprojectPath = path.resolve(skill.pyprojectPath);
		const key = `${skill.importName}\0${packagePath}`;
		if (byKey.has(key)) {
			return;
		}
		const bootstrapSkill: BootstrapPythonSkill = {
			importName: skill.importName,
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		byKey.set(key, bootstrapSkill);
		for (const dependencyName of readPythonSkillDependencyNames(bootstrapSkill)) {
			const siblingDependency = resolveSiblingPythonSkillDependency(bootstrapSkill, dependencyName);
			if (siblingDependency) {
				addSkill(siblingDependency);
			}
		}
	};
	for (const skill of pythonSkills ?? []) {
		addSkill(skill);
	}
	return [...byKey.values()].sort((a, b) => {
		const packageCompare = a.packagePath.localeCompare(b.packagePath);
		if (packageCompare !== 0) return packageCompare;
		return a.importName.localeCompare(b.importName);
	});
}

function readTomlProjectSection(pyprojectPath: string): string | undefined {
	try {
		const text = readFileSync(pyprojectPath, "utf-8");
		const match = text.match(/^\s*\[project\]\s*$/m);
		if (!match || match.index === undefined) {
			return undefined;
		}
		const sectionStart = match.index + match[0].length;
		const rest = text.slice(sectionStart);
		const nextSection = rest.search(/^\s*\[/m);
		return nextSection >= 0 ? rest.slice(0, nextSection) : rest;
	} catch {
		return undefined;
	}
}

function readPythonSkillProjectName(skill: BootstrapPythonSkill): string {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	const name = projectSection?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
	return name?.trim() || skill.importName.replaceAll("_", "-");
}

function parseDependencyPackageName(dependency: string): string | undefined {
	const withoutMarker = dependency.split(";")[0]?.trim() ?? "";
	if (!withoutMarker) {
		return undefined;
	}
	const match = withoutMarker.match(/^([A-Za-z0-9_.-]+)/);
	return match?.[1]?.replaceAll("_", "-").toLowerCase();
}

function findTomlArrayEnd(text: string, startIndex: number): number {
	let inQuote: '"' | "'" | undefined;
	let escaped = false;
	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];
		if (inQuote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inQuote) {
				inQuote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inQuote = char;
			continue;
		}
		if (char === "]") {
			return index;
		}
	}
	return -1;
}

function readPythonSkillDependencyNames(skill: BootstrapPythonSkill): Set<string> {
	const projectSection = readTomlProjectSection(skill.pyprojectPath);
	if (!projectSection) {
		return new Set();
	}
	const dependenciesStart = projectSection.search(/^\s*dependencies\s*=\s*\[/m);
	if (dependenciesStart < 0) {
		return new Set();
	}
	const arrayStart = projectSection.indexOf("[", dependenciesStart);
	if (arrayStart < 0) {
		return new Set();
	}
	const arrayEnd = findTomlArrayEnd(projectSection, arrayStart + 1);
	if (arrayEnd < 0) {
		return new Set();
	}
	const dependenciesArray = projectSection.slice(arrayStart, arrayEnd + 1);
	const dependencies = new Set<string>();
	const dependencyPattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
	for (const match of dependenciesArray.matchAll(dependencyPattern)) {
		const dependency = (match[1] ?? match[2] ?? "").replaceAll('\\"', '"').replaceAll("\\'", "'");
		const name = parseDependencyPackageName(dependency);
		if (name) {
			dependencies.add(name);
		}
	}
	return dependencies;
}

function resolveSiblingPythonSkillDependency(
	skill: BootstrapPythonSkill,
	dependencyName: string,
): BootstrapPythonSkill | undefined {
	const siblingsDir = path.dirname(skill.packagePath);
	for (const entry of readdirSync(siblingsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const packagePath = path.join(siblingsDir, entry.name);
		const pyprojectPath = path.join(packagePath, "pyproject.toml");
		if (!existsSync(pyprojectPath)) {
			continue;
		}
		const dependency: BootstrapPythonSkill = {
			importName: entry.name.replaceAll("-", "_"),
			packagePath,
			pyprojectPath,
			pyprojectHash: fileContentHash(pyprojectPath),
		};
		if (readPythonSkillProjectName(dependency).replaceAll("_", "-").toLowerCase() === dependencyName) {
			return dependency;
		}
	}
	return undefined;
}

function sortPythonSkillsForInstall(pythonSkills: readonly BootstrapPythonSkill[]): BootstrapPythonSkill[] {
	const byProjectName = new Map<string, BootstrapPythonSkill>();
	const originalIndex = new Map<BootstrapPythonSkill, number>();
	for (const [index, skill] of pythonSkills.entries()) {
		originalIndex.set(skill, index);
		byProjectName.set(readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill);
	}

	const dependenciesBySkill = new Map<BootstrapPythonSkill, BootstrapPythonSkill[]>();
	for (const skill of pythonSkills) {
		dependenciesBySkill.set(
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						byProjectName.get(dependencyName) ?? resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		);
	}

	const pending = new Set(pythonSkills);
	const sorted: BootstrapPythonSkill[] = [];
	while (pending.size > 0) {
		let progressed = false;
		for (const skill of [...pending].sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0))) {
			const dependencies = dependenciesBySkill.get(skill) ?? [];
			if (dependencies.some((dependency) => pending.has(dependency))) {
				continue;
			}
			sorted.push(skill);
			pending.delete(skill);
			progressed = true;
		}
		if (!progressed) {
			// Cyclic local skill dependencies cannot be topologically ordered; keep a
			// deterministic order and let uv surface the packaging error if needed.
			sorted.push(...[...pending].sort((a, b) => a.packagePath.localeCompare(b.packagePath)));
			break;
		}
	}
	return sorted;
}

function formatPythonSkillInstallArgs(skill: BootstrapPythonSkill): string[] {
	return ["--editable", skill.packagePath];
}

function ensureKernelPythonKey(pythonSkills: readonly BootstrapPythonSkill[]): string {
	return [
		process.env.PRIME_AGENT_KERNEL_PYTHON ?? "",
		process.env.PRIME_AGENT_KERNEL_VENV ?? "",
		process.env.PRIME_AGENT_RUNTIME_SOURCE ?? "",
		process.env.HOME ?? "",
		process.env.XDG_DATA_HOME ?? "",
		JSON.stringify(pythonSkills),
	].join("\0");
}

function getBaseKernelVenvDir(): string {
	const override = process.env.PRIME_AGENT_KERNEL_VENV;
	if (override) return path.resolve(expandHome(override));
	return path.join(os.homedir(), ".prime", "agent", "kernel-venv");
}

// Skill packages are synced in place; only base dependencies identify a generation.
export function bootstrapGenerationHash(runtimeIdentity: string): string {
	const identity = JSON.stringify({
		schema: BOOTSTRAP_SCHEMA,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		pythonVersion: PYTHON_VERSION,
		readyCheck: RUNTIME_READY_CHECK,
	});
	return createHash("sha256").update(identity).digest("hex").slice(0, BOOTSTRAP_GENERATION_HASH_LENGTH);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generationFamilyPattern(baseDir: string): RegExp {
	const base = escapeRegExp(path.basename(baseDir));
	return new RegExp(`^${base}-[0-9a-f]{${BOOTSTRAP_GENERATION_HASH_LENGTH}}(?:-[0-9a-f]{32})?$`);
}

function generationIdentityPattern(baseDir: string, generationHash: string): RegExp {
	const base = escapeRegExp(path.basename(baseDir));
	return new RegExp(`^${base}-${generationHash}(?:-[0-9a-f]{32})?$`);
}

// A unique path keeps forced rebuilds from overwriting a same-identity live generation.
function newGenerationVenvDir(baseDir: string, generationHash: string): string {
	return `${baseDir}-${generationHash}-${randomUUID().replaceAll("-", "")}`;
}

function bootstrapPointerPath(baseDir: string): string {
	return `${baseDir}${BOOTSTRAP_POINTER_SUFFIX}`;
}

function bootstrapFailedPath(baseDir: string): string {
	return `${baseDir}${BOOTSTRAP_FAILED_SUFFIX}`;
}

function readBootstrapPointer(baseDir: string): BootstrapPointer | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(bootstrapPointerPath(baseDir), "utf8"));
		if (!isRecord(parsed) || typeof parsed.current !== "string") return null;
		return {
			current: parsed.current,
			previous: typeof parsed.previous === "string" ? parsed.previous : undefined,
			updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
		};
	} catch {
		return null;
	}
}

// Reject paths outside this venv family before resolving a pointer.
function publishedGenerationDir(baseDir: string): string | null {
	const pointer = readBootstrapPointer(baseDir);
	if (!pointer) return null;
	if (!generationFamilyPattern(baseDir).test(pointer.current)) return null;
	const dir = path.join(path.dirname(baseDir), pointer.current);
	return existsSync(dir) ? dir : null;
}

function pointerReferences(baseDir: string, generationDir: string): boolean {
	const name = path.basename(generationDir);
	const pointer = readBootstrapPointer(baseDir);
	return pointer?.current === name || pointer?.previous === name;
}

export function getKernelVenvDir(): string {
	const baseDir = getBaseKernelVenvDir();
	return publishedGenerationDir(baseDir) ?? baseDir;
}

function getXdgKernelVenvDir(): string {
	const dataHome = process.env.XDG_DATA_HOME
		? path.resolve(expandHome(process.env.XDG_DATA_HOME))
		: path.join(os.homedir(), ".local", "share");
	return path.join(dataHome, "prime", "agent", "kernel-venv");
}

async function resolveWritableKernelVenvDir(): Promise<string> {
	const primary = getBaseKernelVenvDir();
	try {
		await mkdir(path.dirname(primary), { recursive: true });
		return primary;
	} catch (primaryError) {
		if (process.env.PRIME_AGENT_KERNEL_VENV) {
			throw new Error(`couldn't create kernel venv parent directory for ${primary}: ${errorMessage(primaryError)}`);
		}

		const fallback = getXdgKernelVenvDir();
		try {
			await mkdir(path.dirname(fallback), { recursive: true });
			return fallback;
		} catch (fallbackError) {
			throw new Error(
				`couldn't create kernel venv directory at ${primary} or ${fallback}; set PRIME_AGENT_KERNEL_PYTHON to a python with a current prime-agent-runtime installed. ${errorMessage(fallbackError)}`,
			);
		}
	}
}

function isBatchShim(command: string): boolean {
	return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

function run(command: string, args: string[], options: { stdio?: "ignore" | "inherit" } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		// CPython must read UTF-8 .pth files even under a Windows legacy code page.
		const env = { ...process.env, ...(process.platform === "win32" ? { PYTHONUTF8: "1" } : {}) };
		const batch = isBatchShim(command) ? buildBatchShimInvocation(command, args, env) : undefined;
		const child = spawnHidden(batch ? (process.env.ComSpec ?? "cmd.exe") : command, batch?.args ?? args, {
			env: batch?.env ?? env,
			stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "ignore", "pipe"],
			...(batch ? { windowsVerbatimArguments: true } : {}),
		});
		let stderrTail = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-RUN_STDERR_TAIL_CHARS);
		});
		child.on("error", reject);
		// Wait for stderr to finish before reporting a failed command.
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			const detail = stderrTail.trim();
			reject(new Error(`${command} ${args.join(" ")} failed with ${reason}${detail ? `\n${detail}` : ""}`));
		});
	});
}

async function pythonImports(python: string, moduleName: string): Promise<boolean> {
	try {
		await run(python, ["-c", `import ${moduleName}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function hasPrimeAgentRuntime(python: string): Promise<boolean> {
	try {
		await run(python, ["-c", RUNTIME_READY_CHECK], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

async function missingRlmExtraImportLabels(python: string): Promise<string[]> {
	const missing: string[] = [];
	for (const pkg of DEFAULT_RLM_EXTRA_PACKAGES) {
		if (!(await pythonImports(python, pkg.importName))) {
			missing.push(pkg.promptLabel);
		}
	}
	return missing;
}

async function missingPythonSkillImportLabels(
	python: string,
	pythonSkills: readonly KernelPythonSkill[],
): Promise<string[]> {
	const missing: string[] = [];
	for (const skill of pythonSkills) {
		if (!(await pythonImports(python, skill.importName))) {
			missing.push(`${skill.name} (${skill.importName})`);
		}
	}
	return missing;
}

function reportProgress(options: EnsureKernelPythonOptions, message: string): void {
	if (options.onProgress) {
		options.onProgress(message);
		return;
	}
	process.stderr.write(`${message}\n`);
}

function bootstrapLockDir(venv: string): string {
	return path.join(path.dirname(venv), `${path.basename(venv)}${BOOTSTRAP_LOCK_NAME}`);
}

async function lockMissingPidIsStale(lockDir: string): Promise<boolean> {
	try {
		const lockStat = await stat(lockDir);
		return Date.now() - lockStat.mtimeMs > BOOTSTRAP_LOCK_STALE_WITHOUT_PID_MS;
	} catch {
		return false;
	}
}

async function acquireBootstrapLock(venv: string): Promise<() => Promise<void>> {
	const lockDir = bootstrapLockDir(venv);
	await mkdir(path.dirname(lockDir), { recursive: true });

	for (;;) {
		const attempt = await tryAcquireDirLock(lockDir, async (ownerPid) =>
			ownerPid === undefined ? !(await lockMissingPidIsStale(lockDir)) : isProcessAlive(ownerPid),
		);
		if (attempt === "acquired") {
			return () => rm(lockDir, { recursive: true, force: true });
		}
		if (attempt === "held") {
			await sleep(BOOTSTRAP_LOCK_RETRY_MS);
		}
	}
}

/** Try a bare command followed by supported PATHEXT extensions in the configured order. */
export function windowsExecutableCandidates(name: string, pathext: string | undefined): string[] {
	const extensions = (pathext ?? "")
		.split(";")
		.map((ext) => ext.trim().toLowerCase())
		.filter((ext) => WINDOWS_SUPPORTED_EXECUTABLE_EXTENSIONS.has(ext));
	const lowerName = name.toLowerCase();
	if (WINDOWS_PATHEXT_DEFAULT.some((ext) => lowerName.endsWith(ext.toLowerCase()))) {
		return [name];
	}
	const seen = new Set<string>([name.toLowerCase()]);
	const candidates = [name];
	for (const ext of extensions.length > 0 ? extensions : WINDOWS_PATHEXT_DEFAULT) {
		const candidate = `${name}${ext}`;
		if (seen.has(candidate.toLowerCase())) continue;
		seen.add(candidate.toLowerCase());
		candidates.push(candidate);
	}
	return candidates;
}

async function findExecutable(name: string): Promise<string | null> {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;
	const candidates = process.platform === "win32" ? windowsExecutableCandidates(name, process.env.PATHEXT) : [name];
	for (const dir of pathValue.split(path.delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const fullPath = path.join(dir, candidate);
			if (await isExecutable(fullPath)) return fullPath;
		}
	}
	return null;
}

async function ensureUv(options: EnsureKernelPythonOptions): Promise<string> {
	const fromPath = await findExecutable("uv");
	if (fromPath) return fromPath;

	const localUv = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "uv.exe" : "uv");
	if (await isExecutable(localUv)) return localUv;

	const shouldInstallUv =
		process.env.PRIME_AGENT_INSTALL_UV === "1" || (!options.onProgress && (await confirmUvInstall()));
	if (!shouldInstallUv) {
		throw new Error(
			`uv is required to set up the Python kernel. Install uv yourself: ${UV_INSTALL_COMMAND}, ` +
				"or set PRIME_AGENT_INSTALL_UV=1 to let prime-agent run that installer.",
		);
	}

	reportProgress(options, "› installing uv (one-time)…");
	try {
		await run("sh", ["-c", UV_INSTALL_COMMAND], { stdio: options.onProgress ? "ignore" : "inherit" });
	} catch (error) {
		throw new Error(
			`couldn't install uv from astral.sh; install it yourself: ${UV_INSTALL_COMMAND}, then re-run prime-agent. ${errorMessage(error)}`,
		);
	}

	if (await isExecutable(localUv)) return localUv;
	const installedFromPath = await findExecutable("uv");
	if (installedFromPath) return installedFromPath;
	throw new Error("uv install completed but binary not found at ~/.local/bin/uv");
}

async function confirmUvInstall(): Promise<boolean> {
	if (process.env.PRIME_AGENT_INSTALL_UV === "0") return false;
	if (!stdin.isTTY || !stderr.isTTY) return false;

	const rl = createInterface({ input: stdin, output: stderr });
	try {
		const answer = (await rl.question("Prime Agent needs uv to set up Python. Install uv from astral.sh now? [Y/n] "))
			.trim()
			.toLowerCase();
		return answer !== "n" && answer !== "no";
	} finally {
		rl.close();
	}
}

async function readBootstrapVersion(venv: string): Promise<BootstrapVersion | null> {
	try {
		const raw = await readFile(path.join(venv, BOOTSTRAP_VERSION_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed) || typeof parsed.schema !== "number") return null;
		const extraUvArgs =
			Array.isArray(parsed.extraUvArgs) &&
			parsed.extraUvArgs.every((v: unknown): v is string => typeof v === "string")
				? (parsed.extraUvArgs as string[])
				: undefined;
		let pythonSkills: BootstrapPythonSkill[] | undefined;
		if (Array.isArray(parsed.pythonSkills)) {
			if (
				!parsed.pythonSkills.every((v: unknown): v is BootstrapPythonSkill => {
					if (!isRecord(v)) return false;
					return (
						typeof v.importName === "string" &&
						typeof v.packagePath === "string" &&
						typeof v.pyprojectPath === "string" &&
						typeof v.pyprojectHash === "string"
					);
				})
			) {
				return null;
			}
			pythonSkills = parsed.pythonSkills as BootstrapPythonSkill[];
		}
		return {
			schema: parsed.schema,
			runtime: typeof parsed.runtime === "string" ? parsed.runtime : undefined,
			snapshot: typeof parsed.snapshot === "string" ? parsed.snapshot : undefined,
			extraUvArgs,
			generation: typeof parsed.generation === "string" ? parsed.generation : undefined,
			pythonSkills,
		};
	} catch {
		return null;
	}
}

function extraUvArgsMatch(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function pythonSkillsMatch(a: BootstrapPythonSkill[] | undefined, b: readonly BootstrapPythonSkill[]): boolean {
	const left = a ?? [];
	if (left.length !== b.length) return false;
	return left.every((skill, index) => {
		const expected = b[index];
		return (
			skill.importName === expected.importName &&
			skill.packagePath === expected.packagePath &&
			skill.pyprojectPath === expected.pyprojectPath &&
			skill.pyprojectHash === expected.pyprojectHash
		);
	});
}

function bootstrapVersionCurrent(
	version: BootstrapVersion | null,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): boolean {
	return (
		version !== null &&
		bootstrapBaseVersionCurrent(version, runtimeIdentity) &&
		pythonSkillsMatch(version.pythonSkills, pythonSkills)
	);
}

function bootstrapBaseVersionCurrent(version: BootstrapVersion | null, runtimeIdentity: string): boolean {
	return (
		version?.schema === BOOTSTRAP_SCHEMA &&
		version.runtime === runtimeIdentity &&
		version.snapshot === STATE_SNAPSHOT_REQUIREMENT &&
		extraUvArgsMatch(version.extraUvArgs, DEFAULT_RLM_EXTRA_UV_ARGS) &&
		version.generation === bootstrapGenerationHash(runtimeIdentity)
	);
}

async function writeBootstrapVersion(
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<void> {
	const version: BootstrapVersion = {
		schema: BOOTSTRAP_SCHEMA,
		runtime: runtimeIdentity,
		snapshot: STATE_SNAPSHOT_REQUIREMENT,
		extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
		generation: bootstrapGenerationHash(runtimeIdentity),
		pythonSkills: [...pythonSkills],
	};
	writeFileAtomicSync(path.join(venv, BOOTSTRAP_VERSION_FILE), `${JSON.stringify(version)}\n`);
}

function runtimeCandidateDirs(): string[] {
	const override = process.env.PRIME_AGENT_RUNTIME_SOURCE;
	if (override) return [path.resolve(expandHome(override))];
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	// Compiled executables use a flat sidecar layout; Node packages keep sources in dist/.
	// Resolve both from the physical package directory, outside Bun's virtual filesystem.
	return [
		path.join(getPackageDir(), "prime-agent-runtime"),
		path.join(getPackageDir(), "dist", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "prime-agent-runtime"),
		path.resolve(moduleDir, "..", "..", "..", "..", "..", "prime-agent-runtime"),
	];
}

async function resolveRuntimeSourceDir(): Promise<string | null> {
	for (const candidate of runtimeCandidateDirs()) {
		if (await exists(path.join(candidate, "pyproject.toml"))) {
			return candidate;
		}
	}
	return null;
}

// The runtime ships as local source. There is no package-index fallback.
async function requireRuntimeSourceDir(): Promise<string> {
	const sourceDir = await resolveRuntimeSourceDir();
	if (sourceDir) return sourceDir;
	throw missingRuntimeSourceError(runtimeCandidateDirs());
}

function missingRuntimeSourceError(candidates: string[]): Error {
	return new Error(
		`Failed to set up the Python kernel runtime: the ${RUNTIME_PACKAGE_NAME} source that ships with this prime-agent install is missing ` +
			`(looked in: ${candidates.join(", ")}). ` +
			"The install this process was started from was probably deleted, moved, or replaced while prime-agent was running. " +
			"The existing kernel venv was left untouched. Restart prime-agent from an intact install, " +
			`point PRIME_AGENT_RUNTIME_SOURCE at a ${RUNTIME_PACKAGE_NAME} checkout, ` +
			`or set PRIME_AGENT_KERNEL_PYTHON to a Python with a current ${RUNTIME_PACKAGE_NAME} and default Python packages installed.`,
	);
}

export async function resolveRuntimeIdentity(): Promise<string> {
	return hashRuntimeSource(await requireRuntimeSourceDir());
}

async function hashRuntimeSource(sourceDir: string): Promise<string> {
	const rlmDir = path.join(sourceDir, "src", "rlm");
	const files: string[] = [path.join(sourceDir, "pyproject.toml")];
	async function collect(dir: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await collect(full);
			} else if (entry.isFile() && entry.name.endsWith(".py")) {
				files.push(full);
			}
		}
	}
	await collect(rlmDir);
	files.sort();
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(path.relative(sourceDir, file));
		hash.update("\0");
		hash.update(await readFile(file));
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

export function kernelVenvPython(venv: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

async function bootstrapVenv(
	venv: string,
	runtimeSourceDir: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	await mkdir(path.dirname(venv), { recursive: true });
	const uv = await ensureUv(options);
	const python = kernelVenvPython(venv);

	await run(uv, ["python", "install", PYTHON_VERSION]);
	await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"]);
	await run(uv, [
		"pip",
		"install",
		"--python",
		python,
		runtimeSourceDir,
		STATE_SNAPSHOT_REQUIREMENT,
		...DEFAULT_RLM_EXTRA_UV_ARGS,
	]);
	await syncPythonSkills(uv, venv, python, runtimeIdentity, pythonSkills, options);
}

async function syncPythonSkills(
	uv: string,
	venv: string,
	python: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
	options: EnsureKernelPythonOptions,
): Promise<void> {
	const version = await readBootstrapVersion(venv);
	const installedPythonSkills: BootstrapPythonSkill[] = [];
	const currentPythonSkills = new Map(
		(version?.pythonSkills ?? []).map((skill) => [`${skill.importName}\0${skill.packagePath}`, skill]),
	);
	const pythonSkillsByProjectName = new Map(
		pythonSkills.map((skill) => [readPythonSkillProjectName(skill).replaceAll("_", "-").toLowerCase(), skill]),
	);
	const dependenciesBySkill = new Map(
		pythonSkills.map((skill) => [
			skill,
			[...readPythonSkillDependencyNames(skill)]
				.map(
					(dependencyName) =>
						pythonSkillsByProjectName.get(dependencyName) ??
						resolveSiblingPythonSkillDependency(skill, dependencyName),
				)
				.filter((dependency): dependency is BootstrapPythonSkill => Boolean(dependency)),
		]),
	);

	for (const skill of sortPythonSkillsForInstall(pythonSkills)) {
		const existingSkill = currentPythonSkills.get(`${skill.importName}\0${skill.packagePath}`);
		if (existingSkill?.pyprojectPath === skill.pyprojectPath && existingSkill.pyprojectHash === skill.pyprojectHash) {
			installedPythonSkills.push(skill);
			continue;
		}

		const localDependencies = dependenciesBySkill.get(skill) ?? [];
		const localDependencyArgs = localDependencies
			.filter((dependency) => {
				const installedDependency = currentPythonSkills.get(`${dependency.importName}\0${dependency.packagePath}`);
				const installedThisSync = installedPythonSkills.some(
					(installed) =>
						installed.importName === dependency.importName &&
						installed.packagePath === dependency.packagePath &&
						installed.pyprojectPath === dependency.pyprojectPath &&
						installed.pyprojectHash === dependency.pyprojectHash,
				);
				return !(
					installedThisSync ||
					(installedDependency?.pyprojectPath === dependency.pyprojectPath &&
						installedDependency.pyprojectHash === dependency.pyprojectHash)
				);
			})
			.flatMap(formatPythonSkillInstallArgs);

		try {
			await run(uv, [
				"pip",
				"install",
				"--python",
				python,
				...formatPythonSkillInstallArgs(skill),
				...localDependencyArgs,
			]);
			installedPythonSkills.push(
				skill,
				...localDependencies.filter((dependency) => !installedPythonSkills.includes(dependency)),
			);
		} catch (error) {
			reportProgress(
				options,
				`Warning: Python skill ${skill.importName} failed to install and will be unavailable: ${errorMessage(error)}`,
			);
		}
	}
	await writeBootstrapVersion(venv, runtimeIdentity, installedPythonSkills);
}

async function kernelBaseReady(python: string, venv: string, runtimeIdentity: string): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapBaseVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity)
	);
}

async function kernelReady(
	python: string,
	venv: string,
	runtimeIdentity: string,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<boolean> {
	return (
		(await hasPrimeAgentRuntime(python)) &&
		bootstrapVersionCurrent(await readBootstrapVersion(venv), runtimeIdentity, pythonSkills)
	);
}

function formatBootstrapFailure(error: unknown): Error {
	return new Error(
		`Failed to set up the Python kernel runtime. ${errorMessage(error)}\n` +
			"First-time setup needs internet to install uv, Python, prime-agent-runtime, and default Python packages; once set up, prime-agent runs offline. " +
			"An interrupted runtime upgrade needs network once more, so re-run this while online. " +
			"Set PRIME_AGENT_KERNEL_PYTHON to a Python with a current prime-agent-runtime and default Python packages installed to skip auto-bootstrap.",
	);
}

async function publishGeneration(baseDir: string, generationDir: string): Promise<void> {
	const current = path.basename(generationDir);
	const familyPattern = generationFamilyPattern(baseDir);
	const existing = readBootstrapPointer(baseDir);
	const previousCandidate = existing && existing.current !== current ? existing.current : existing?.previous;
	const previous =
		previousCandidate && previousCandidate !== current && familyPattern.test(previousCandidate)
			? previousCandidate
			: undefined;
	const pointer: BootstrapPointer = {
		current,
		...(previous ? { previous } : {}),
		updatedAt: Date.now(),
	};
	writeFileAtomicSync(bootstrapPointerPath(baseDir), `${JSON.stringify(pointer)}\n`);
}

function readBootstrapFailure(baseDir: string): BootstrapFailureMarker | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(bootstrapFailedPath(baseDir), "utf8"));
		if (
			!isRecord(parsed) ||
			typeof parsed.identity !== "string" ||
			typeof parsed.attempt !== "number" ||
			typeof parsed.nextRetryAt !== "number"
		) {
			return null;
		}
		return {
			identity: parsed.identity,
			attempt: parsed.attempt,
			nextRetryAt: parsed.nextRetryAt,
			lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
		};
	} catch {
		return null;
	}
}

function bootstrapBackoffMs(attempt: number): number {
	const exponent = Math.max(0, attempt - 1);
	return Math.min(BOOTSTRAP_BACKOFF_BASE_MS * 2 ** exponent, BOOTSTRAP_BACKOFF_MAX_MS);
}

async function recordBootstrapFailure(baseDir: string, identity: string, error: unknown): Promise<void> {
	const existing = readBootstrapFailure(baseDir);
	const attempt = existing && existing.identity === identity ? existing.attempt + 1 : 1;
	const marker: BootstrapFailureMarker = {
		identity,
		attempt,
		nextRetryAt: Date.now() + bootstrapBackoffMs(attempt),
		lastError: errorMessage(error).slice(0, RUN_STDERR_TAIL_CHARS),
	};
	writeFileAtomicSync(bootstrapFailedPath(baseDir), `${JSON.stringify(marker)}\n`);
}

// A stale marker must not turn a successful publication into a failed boot.
async function clearBootstrapFailure(baseDir: string): Promise<void> {
	await rm(bootstrapFailedPath(baseDir), { force: true }).catch(() => undefined);
}

function bootstrapBackoffError(marker: BootstrapFailureMarker): Error {
	const retryAt = new Date(marker.nextRetryAt).toISOString();
	return new KernelBootstrapUnavailableError(
		`kernel venv bootstrap failed ${marker.attempt} time(s) for this runtime; ` +
			`not rebuilding again before ${retryAt} (a runtime, python-version, or readiness-check change retries immediately; a skill change syncs in place). ` +
			`Last error: ${marker.lastError ?? "unknown"}`,
	);
}

class KernelBootstrapUnavailableError extends Error {}

// Reuse an intact generation on rollback instead of building the same runtime again.
async function findReusableGeneration(
	baseDir: string,
	generationHash: string,
	skipDir: string,
	runtimeIdentity: string,
): Promise<string | null> {
	const parent = path.dirname(baseDir);
	const identityPattern = generationIdentityPattern(baseDir, generationHash);
	const skipName = path.basename(skipDir);
	const candidates: { dir: string; mtimeMs: number }[] = [];
	try {
		for (const entry of await readdir(parent, { withFileTypes: true })) {
			if (!entry.isDirectory() || !identityPattern.test(entry.name) || entry.name === skipName) continue;
			const dir = path.join(parent, entry.name);
			try {
				candidates.push({ dir, mtimeMs: (await stat(dir)).mtimeMs });
			} catch {
				// Ignore a generation removed since the directory listing.
			}
		}
	} catch {
		return null;
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { dir } of candidates) {
		if (await kernelBaseReady(kernelVenvPython(dir), dir, runtimeIdentity)) return dir;
	}
	return null;
}

async function ensureKernelPythonUncached(
	options: EnsureKernelPythonOptions,
	pythonSkills: readonly BootstrapPythonSkill[],
): Promise<string> {
	const override = process.env.PRIME_AGENT_KERNEL_PYTHON;
	if (override) {
		const python = path.resolve(expandHome(override));
		if (isBatchShim(python)) {
			throw new Error(
				`PRIME_AGENT_KERNEL_PYTHON must point directly to a Python executable, not a Windows batch shim: ${python}`,
			);
		}
		const missing: string[] = [];
		if (!(await hasPrimeAgentRuntime(python))) {
			missing.push(
				"a current prime-agent-runtime with callable rlm.spawn, rlm.create_session, rlm.host_request, rlm.progress_note, and explicit harness CRUD methods",
			);
		}
		if (missing.length === 0) {
			const missingExtraImports = await missingRlmExtraImportLabels(python);
			if (missingExtraImports.length > 0) {
				missing.push(`default Python packages (${missingExtraImports.join(", ")})`);
			}
		}
		if (missing.length === 0 && pythonSkills.length > 0) {
			const missingPythonSkills = await missingPythonSkillImportLabels(python, options.pythonSkills ?? []);
			if (missingPythonSkills.length > 0) {
				reportProgress(
					options,
					`Warning: Python skills unavailable in PRIME_AGENT_KERNEL_PYTHON and will be disabled: ${missingPythonSkills.join(", ")}`,
				);
			}
		}
		if (missing.length === 0) return python;
		throw new Error(`PRIME_AGENT_KERNEL_PYTHON points to a Python missing ${missing.join(" and ")}: ${python}`);
	}

	// Resolve sources before modifying any venv or bootstrap metadata.
	const runtimeSourceDir = await requireRuntimeSourceDir();
	const runtimeIdentity = await hashRuntimeSource(runtimeSourceDir);
	const baseDir = await resolveWritableKernelVenvDir();
	const generationHash = bootstrapGenerationHash(runtimeIdentity);
	const forceRebuild = options.forceRebuild === true;

	const liveDir = publishedGenerationDir(baseDir) ?? baseDir;
	const livePython = kernelVenvPython(liveDir);
	if (!forceRebuild && (await kernelReady(livePython, liveDir, runtimeIdentity, pythonSkills))) return livePython;

	const releaseLock = await acquireBootstrapLock(baseDir);
	try {
		const currentDir = publishedGenerationDir(baseDir) ?? baseDir;
		const currentPython = kernelVenvPython(currentDir);
		if (!forceRebuild && (await kernelReady(currentPython, currentDir, runtimeIdentity, pythonSkills)))
			return currentPython;

		// A matching manifest plus a failed probe can mean memory pressure, not a stale runtime.
		if (!forceRebuild && bootstrapBaseVersionCurrent(await readBootstrapVersion(currentDir), runtimeIdentity)) {
			if (await hasPrimeAgentRuntime(currentPython)) {
				await syncPythonSkills(
					await ensureUv(options),
					currentDir,
					currentPython,
					runtimeIdentity,
					pythonSkills,
					options,
				);
				return currentPython;
			}
			if (existsSync(currentPython)) {
				throw new KernelBootstrapUnavailableError(
					`the live kernel venv (${currentDir}) is recorded for the current runtime but failed its readiness probe; ` +
						"leaving it untouched. Retry when memory is available. To select another generation, remove only " +
						`the pointer file (${bootstrapPointerPath(baseDir)}) and retry; do not delete the venv directory. ` +
						"If the bootstrap CLI is available, run it with PRIME_AGENT_KERNEL_VENV_FORCE_REBUILD=1 to build a fresh generation.",
				);
			}
		}

		if (!forceRebuild) {
			const reusable = await findReusableGeneration(baseDir, generationHash, currentDir, runtimeIdentity);
			if (reusable) {
				const reusablePython = kernelVenvPython(reusable);
				await syncPythonSkills(
					await ensureUv(options),
					reusable,
					reusablePython,
					runtimeIdentity,
					pythonSkills,
					options,
				);
				await publishGeneration(baseDir, reusable);
				await clearBootstrapFailure(baseDir);
				return reusablePython;
			}

			const marker = readBootstrapFailure(baseDir);
			if (marker && marker.identity === generationHash && Date.now() < marker.nextRetryAt) {
				throw bootstrapBackoffError(marker);
			}
		}

		const buildDir = newGenerationVenvDir(baseDir, generationHash);
		const generationPython = kernelVenvPython(buildDir);
		let published = false;
		try {
			reportProgress(options, "› setting up python kernel (one-time, ~30s)…");
			await bootstrapVenv(buildDir, runtimeSourceDir, runtimeIdentity, pythonSkills, options);
			if (!(await kernelBaseReady(generationPython, buildDir, runtimeIdentity))) {
				throw new Error(`kernel venv failed its readiness check after bootstrap: ${buildDir}`);
			}
			// Publication can succeed before a later I/O error. Never delete this directory again.
			published = true;
			await publishGeneration(baseDir, buildDir);
		} catch (error) {
			if (!published && !pointerReferences(baseDir, buildDir)) {
				await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
			}
			await recordBootstrapFailure(baseDir, generationHash, error).catch(() => undefined);
			throw error;
		}
		await clearBootstrapFailure(baseDir);
		reportProgress(options, "✓ ready");
		return generationPython;
	} catch (error) {
		if (error instanceof KernelBootstrapUnavailableError) throw error;
		throw formatBootstrapFailure(error);
	} finally {
		await releaseLock().catch(() => undefined);
	}
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
	const pythonSkills = normalizePythonSkills(options.pythonSkills);
	const key = `${ensureKernelPythonKey(pythonSkills)}\0${options.forceRebuild === true}`;
	if (inFlightEnsureKernelPython?.key === key) return inFlightEnsureKernelPython.promise;

	const promise = ensureKernelPythonUncached(options, pythonSkills).finally(() => {
		if (inFlightEnsureKernelPython?.promise === promise) inFlightEnsureKernelPython = null;
	});
	inFlightEnsureKernelPython = { key, promise };
	return promise;
}
