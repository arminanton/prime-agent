import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bootstrapGenerationHash,
	DEFAULT_RLM_EXTRA_IMPORT_NAMES,
	DEFAULT_RLM_EXTRA_UV_ARGS,
	ensureKernelPython,
	getKernelVenvDir,
	type KernelPythonSkill,
	kernelVenvPython,
	resolveRuntimeIdentity,
	runKernelPrebuild,
} from "../src/core/kernel/bootstrap.js";

let tempDir = "";
let originalEnv: NodeJS.ProcessEnv;
let runtimeIdentity = "";

function pyprojectHash(pyprojectPath: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(pyprojectPath)).digest("hex")}`;
}

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function writeBootstrapVersion(venv: string, pythonSkills: readonly KernelPythonSkill[] = []): void {
	writeFileSync(
		join(venv, ".bootstrap-version"),
		`${JSON.stringify({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			generation: bootstrapGenerationHash(runtimeIdentity),
			pythonSkills: pythonSkills.map((skill) => ({
				importName: skill.importName,
				packagePath: skill.packagePath,
				pyprojectPath: skill.pyprojectPath,
				pyprojectHash: pyprojectHash(skill.pyprojectPath),
			})),
		})}\n`,
	);
}

function generationIdentityHash(identity: string): string {
	return bootstrapGenerationHash(identity);
}

// Each build now lands in a unique nonce-suffixed sibling `<base>-<hash>-<nonce>` that the
// pointer publishes, so the exact dir name is only known after the build. Resolve the live
// generation dir the same way production readers do: via getKernelVenvDir().
function liveGenerationDir(): string {
	return getKernelVenvDir();
}

// A minimal prime-agent-runtime source whose content (and therefore identity hash)
// changes with initContent, used to drive generation changes in tests.
function writeRuntimeSource(dir: string, initContent: string): void {
	mkdirSync(join(dir, "src", "rlm"), { recursive: true });
	writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "prime-agent-runtime"\nversion = "0.0.0"\n');
	writeFileSync(join(dir, "src", "rlm", "__init__.py"), initContent);
}

function createPythonSkill(name = "web-search"): KernelPythonSkill {
	const packagePath = join(tempDir, "skills", name);
	const importName = name.replaceAll("-", "_");
	const pyprojectPath = join(packagePath, "pyproject.toml");
	mkdirSync(join(packagePath, "src", importName), { recursive: true });
	writeFileSync(
		pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
`,
	);
	writeFileSync(join(packagePath, "src", importName, "__init__.py"), "async def run():\n    return 'ok'\n");
	return {
		name,
		importName,
		packagePath,
		pyprojectPath,
	};
}

function createPythonSkillWithDependency(name: string, dependencyName: string): KernelPythonSkill {
	const skill = createPythonSkill(name);
	writeFileSync(
		skill.pyprojectPath,
		`[project]
name = "${name}"
version = "0.1.0"
dependencies = ["${dependencyName}"]
`,
	);
	return skill;
}

function writeFakePython(filePath: string, importableModules: readonly string[]): void {
	const cases = importableModules.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`).join("\n");
	const runtimeCase = importableModules.includes("rlm") ? '    *"_harness_methods"*) exit 0 ;;' : "";
	writeExecutable(
		filePath,
		[
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			cases,
			runtimeCase,
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
}

function installFakeUv(): string {
	const binDir = join(tempDir, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = join(tempDir, "uv.log");
	const extraImportCases = DEFAULT_RLM_EXTRA_IMPORT_NAMES.map((moduleName) => `    "import ${moduleName}") exit 0 ;;`);
	process.env.UV_LOG = logPath;
	process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
	writeExecutable(
		join(binDir, "uv"),
		[
			"#!/bin/sh",
			"set -e",
			'printf "%s\\n" "$*" >> "$UV_LOG"',
			'if [ "$1" = "python" ]; then',
			"  exit 0",
			"fi",
			'if [ "$1" = "venv" ]; then',
			'  venv="$2"',
			'  mkdir -p "$venv/bin"',
			"  cat > \"$venv/bin/python\" <<'PY'",
			"#!/bin/sh",
			'if [ "$1" = "-c" ]; then',
			'  case "$2" in',
			'    "import rlm") exit 0 ;;',
			...extraImportCases,
			'    *"_harness_methods"*) exit 0 ;;',
			"    *) exit 1 ;;",
			"  esac",
			"fi",
			"exit 0",
			"PY",
			'  chmod +x "$venv/bin/python"',
			"  exit 0",
			"fi",
			'if [ "$1" = "pip" ]; then',
			'  for arg in "$@"; do',
			'    if [ "$UV_FAIL_ARG" != "" ] && [ "$arg" = "$UV_FAIL_ARG" ]; then',
			'      echo "fake uv: refusing to install $arg" >&2',
			"      exit 1",
			"    fi",
			"  done",
			"  exit 0",
			"fi",
			"exit 2",
			"",
		].join("\n"),
	);
	return logPath;
}

describe("kernel bootstrap", () => {
	beforeEach(async () => {
		runtimeIdentity = await resolveRuntimeIdentity();
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.PRIME_AGENT_RUNTIME_SOURCE;
		delete process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("returns the configured kernel venv directory", () => {
		const venv = join(tempDir, "custom-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		expect(getKernelVenvDir()).toBe(venv);
	});

	it("bootstraps a missing venv with uv, prime-agent-runtime, and default extra packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython();
		const gen = liveGenerationDir();
		expect(python).toBe(join(gen, "bin", "python"));
		// The build lands in a unique nonce-suffixed sibling, never at the base path.
		expect(gen).toMatch(new RegExp(`^${venv}-[0-9a-f]{16}-[0-9a-f]{32}$`));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${gen} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).not.toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}
		const version = JSON.parse(readFileSync(join(gen, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			generation: bootstrapGenerationHash(runtimeIdentity),
			pythonSkills: [],
		});
		expect(version.runtime).toMatch(/^sha256:/);
		// The base path is never turned into a venv; the versioned generation holds it.
		expect(existsSync(join(venv, "bin", "python"))).toBe(false);
	});

	it("installs the runtime from PRIME_AGENT_RUNTIME_SOURCE when set", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		mkdirSync(join(runtimeSource, "src", "rlm"), { recursive: true });
		writeFileSync(
			join(runtimeSource, "pyproject.toml"),
			'[project]\nname = "prime-agent-runtime"\nversion = "0.0.0"\n',
		);
		writeFileSync(join(runtimeSource, "src", "rlm", "__init__.py"), "spawn = None\n");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;

		const sourceIdentity = await resolveRuntimeIdentity();
		const python = await ensureKernelPython();
		const gen = liveGenerationDir();
		expect(python).toBe(join(gen, "bin", "python"));
		expect(gen).toMatch(new RegExp(`^${venv}-[0-9a-f]{16}-[0-9a-f]{32}$`));

		expect(readFileSync(logPath, "utf8")).toContain(
			`pip install --python ${join(gen, "bin", "python")} ${runtimeSource} dill`,
		);
		const version = JSON.parse(readFileSync(join(gen, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(sourceIdentity);
		expect(version.runtime).toMatch(/^sha256:/);
		expect(version.runtime).not.toBe(runtimeIdentity);
	});

	it("fails without tearing down a stale venv when the runtime source is missing", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		// A stale identity would normally trigger rm -rf + rebuild of the shared venv.
		const staleVersion = `${JSON.stringify({
			schema: 9,
			runtime: "sha256:stale",
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			pythonSkills: [],
		})}\n`;
		writeFileSync(join(venv, ".bootstrap-version"), staleVersion);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const missingSource = join(tempDir, "missing-runtime");
		process.env.PRIME_AGENT_RUNTIME_SOURCE = missingSource;

		const error = await ensureKernelPython().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toMatch(/prime-agent-runtime source .* is missing/);
		expect(message).toContain(missingSource);
		expect(message).toContain("left untouched");
		expect(message).not.toContain("First-time setup needs internet");
		expect(readFileSync(join(venv, ".bootstrap-version"), "utf8")).toBe(staleVersion);
		expect(existsSync(python)).toBe(true);
		expect(existsSync(logPath)).toBe(false);
	});

	it("includes the failing command's stderr in the bootstrap error", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = "dill";

		await expect(ensureKernelPython()).rejects.toThrow(
			/failed with exit code 1\nfake uv: refusing to install dill\nFirst-time setup needs internet/,
		);
	});

	it("routes bootstrap progress through the provided callback", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const progress: string[] = [];
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			const python = await ensureKernelPython({ onProgress: (message) => progress.push(message) });
			expect(python).toBe(join(liveGenerationDir(), "bin", "python"));
		} finally {
			stderrWrite.mockRestore();
		}

		expect(progress).toEqual(expect.arrayContaining(["› setting up python kernel (one-time, ~30s)…", "✓ ready"]));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("setting up python kernel"));
		expect(stderrWrite).not.toHaveBeenCalledWith(expect.stringContaining("ready"));
	});

	it("installs Python skills into the bootstrapped venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython({ pythonSkills: [pythonSkill] });
		const gen = liveGenerationDir();
		expect(python).toBe(join(gen, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(gen, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: pythonSkill.importName,
				packagePath: pythonSkill.packagePath,
				pyprojectPath: pythonSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies with dependent editable packages", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("agent-observe");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "agent-observe");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython({ pythonSkills: [dependentSkill] });
		const gen = liveGenerationDir();
		expect(python).toBe(join(gen, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(gen, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: dependencySkill.importName,
				packagePath: dependencySkill.packagePath,
				pyprojectPath: dependencySkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependencySkill.pyprojectPath),
			},
			{
				importName: dependentSkill.importName,
				packagePath: dependentSkill.packagePath,
				pyprojectPath: dependentSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(dependentSkill.pyprojectPath),
			},
		]);
	});

	it("installs sibling Python skill dependencies when package and directory names differ", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		writeFileSync(
			dependencySkill.pyprojectPath,
			`[project]
name = "prime-agent-skill-attach-image"
version = "0.1.0"
`,
		);
		const dependentSkill = createPythonSkillWithDependency(
			"orchestration-heartbeat",
			"prime-agent-skill-attach-image",
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython({ pythonSkills: [dependentSkill] });
		expect(python).toBe(join(liveGenerationDir(), "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("parses Python skill dependencies with extras", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("gidgethub");
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", "gidgethub[httpx]>4.0.0");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython({ pythonSkills: [dependentSkill] });
		expect(python).toBe(join(liveGenerationDir(), "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${dependencySkill.packagePath}`);
		expect(log).toContain(`--editable ${dependentSkill.packagePath}`);
	});

	it("syncs a warm venv when a Python skill pyproject changes", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv, [pythonSkill]);
		writeFileSync(
			pythonSkill.pyprojectPath,
			`[project]
name = "${pythonSkill.name}"
version = "0.1.0"
dependencies = ["httpx"]
`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(python);

		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(`venv ${venv} --python 3.11 --seed`);
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(venv, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills[0].pyprojectHash).toBe(pyprojectHash(pythonSkill.pyprojectPath));
	});

	it("continues when a Python skill editable install fails and retries it next startup", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const goodSkill = createPythonSkill("good-skill");
		const brokenSkill = createPythonSkill("broken-skill");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.UV_FAIL_ARG = brokenSkill.packagePath;

		const firstPython = await ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] });
		const gen = liveGenerationDir();
		expect(firstPython).toBe(join(gen, "bin", "python"));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${goodSkill.packagePath}`);
		expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(gen, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
			},
		]);

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(
			join(gen, "bin", "python"),
		);
		expect(liveGenerationDir()).toBe(gen);

		const retryLog = readFileSync(logPath, "utf8");
		expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${gen} `))).toHaveLength(1);
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
	});

	it("rebuilds a warm venv with legacy unhashed Python skill manifest entries", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		const pythonSkill = createPythonSkill();
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 4,
				runtime: "prime-agent-runtime",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [
					{
						importName: pythonSkill.importName,
						packagePath: pythonSkill.packagePath,
						pyprojectPath: pythonSkill.pyprojectPath,
					},
				],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const built = await ensureKernelPython();
		const gen = liveGenerationDir();
		expect(built).toBe(join(gen, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${gen} --python 3.11 --seed`);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const [first, second] = await Promise.all([ensureKernelPython(), ensureKernelPython()]);
		const gen = liveGenerationDir();
		expect([first, second]).toEqual([join(gen, "bin", "python"), join(gen, "bin", "python")]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${gen} `))).toHaveLength(1);
	});

	it("reuses a current warm venv without invoking uv", async () => {
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await expect(ensureKernelPython()).resolves.toBe(python);
	});

	it("rebuilds a warm venv whose recorded runtime hash no longer matches local source", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		writeFileSync(
			join(venv, ".bootstrap-version"),
			`${JSON.stringify({
				schema: 9,
				runtime: "sha256:stale",
				snapshot: "dill",
				extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
				pythonSkills: [],
			})}\n`,
		);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const built = await ensureKernelPython();
		const gen = liveGenerationDir();
		expect(built).toBe(join(gen, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${gen} --python 3.11 --seed`);
		const version = JSON.parse(readFileSync(join(gen, ".bootstrap-version"), "utf8"));
		expect(version.runtime).toBe(runtimeIdentity);
	});

	it("does not rebuild a live venv whose recorded generation matches but readiness probe fails", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		// The recorded base matches the current identity, but the interpreter fails the full
		// readiness probe (a stale rlm, or a transient spawn/out-of-memory failure under load).
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		// It must fail clean instead of rm-ing and rebuilding the live venv other kernels use.
		await expect(ensureKernelPython()).rejects.toThrow(/failed its readiness probe/);
		// uv is never invoked and the live venv is left intact.
		expect(existsSync(logPath)).toBe(false);
		expect(existsSync(python)).toBe(true);
	});

	it("rebuilds a broken venv", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeBootstrapVersion(venv);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const built = await ensureKernelPython();
		const gen = liveGenerationDir();
		expect(built).toBe(join(gen, "bin", "python"));

		expect(readFileSync(logPath, "utf8")).toContain(`venv ${gen} --python 3.11 --seed`);
	});

	it("leaves the previous generation intact and records a backoff marker when a rebuild fails", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;

		// A first generation builds and publishes cleanly.
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		const first = await resolveRuntimeIdentity();
		const genAPython = await ensureKernelPython();
		const genA = liveGenerationDir();
		expect(genAPython).toBe(join(genA, "bin", "python"));
		expect(getKernelVenvDir()).toBe(genA);

		// A runtime change forces a new generation, but this rebuild fails.
		writeRuntimeSource(runtimeSource, "spawn = 2\n");
		const second = await resolveRuntimeIdentity();
		expect(second).not.toBe(first);
		process.env.UV_FAIL_ARG = "dill";

		await expect(ensureKernelPython()).rejects.toThrow(/Failed to set up the Python kernel runtime/);

		// The previous good generation is untouched and still the published one.
		expect(existsSync(join(genA, "bin", "python"))).toBe(true);
		expect(getKernelVenvDir()).toBe(genA);
		// The failed build's unique dir was removed; only the good generation remains.
		const familyDirs = readdirSync(dirname(venv)).filter((name) => name.startsWith(`${basename(venv)}-`));
		expect(familyDirs).toEqual([basename(genA)]);
		// A backoff marker for the failing identity is recorded.
		const marker = JSON.parse(readFileSync(`${venv}.bootstrap-failed`, "utf8"));
		expect(marker.identity).toBe(generationIdentityHash(second));
		expect(marker.attempt).toBe(1);
		expect(marker.nextRetryAt).toBeGreaterThan(Date.now());
	});

	it("fails fast without running uv while a matching backoff marker is unexpired", async () => {
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;
		const identity = await resolveRuntimeIdentity();
		// A marker for the current identity with a retry time in the future.
		writeFileSync(
			`${venv}.bootstrap-failed`,
			JSON.stringify({
				identity: generationIdentityHash(identity),
				attempt: 3,
				nextRetryAt: Date.now() + 10 * 60_000,
				lastError: "boom",
			}),
		);
		const logPath = installFakeUv();

		await expect(ensureKernelPython()).rejects.toThrow(/not rebuilding again before/);
		// uv is never invoked: the fake uv only writes its log when it runs.
		expect(existsSync(logPath)).toBe(false);
	});

	it("retries immediately for a changed identity even when a backoff marker exists", async () => {
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;
		// A stale marker for a DIFFERENT identity must not block this build.
		writeFileSync(
			`${venv}.bootstrap-failed`,
			JSON.stringify({
				identity: "sha256:some-old-identity",
				attempt: 5,
				nextRetryAt: Date.now() + 30 * 60_000,
				lastError: "old",
			}),
		);
		const logPath = installFakeUv();
		const identity = await resolveRuntimeIdentity();

		const built = await ensureKernelPython();
		const gen = liveGenerationDir();
		expect(built).toBe(join(gen, "bin", "python"));
		expect(gen).toMatch(new RegExp(`^${venv}-${generationIdentityHash(identity)}-[0-9a-f]{32}$`));
		expect(readFileSync(logPath, "utf8")).toContain(`venv ${gen} --python 3.11 --seed`);
		expect(getKernelVenvDir()).toBe(gen);
		// A successful build clears the stale marker.
		expect(existsSync(`${venv}.bootstrap-failed`)).toBe(false);
	});

	it("publishes each generation by writing a single pointer file", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;

		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		await ensureKernelPython();
		const genA = liveGenerationDir();

		// A single small pointer names the live generation; the base path is never a venv,
		// so publishing is one write and never a directory rename (uv writes absolute shebangs).
		const pointer = JSON.parse(readFileSync(`${venv}.current`, "utf8"));
		expect(pointer.current).toBe(basename(genA));
		expect(pointer.previous).toBeUndefined();
		expect(getKernelVenvDir()).toBe(genA);
		expect(existsSync(join(venv, "bin", "python"))).toBe(false);

		// Publishing a new generation records the prior one for rollback and keeps it.
		writeRuntimeSource(runtimeSource, "spawn = 2\n");
		await ensureKernelPython();
		const genB = liveGenerationDir();
		expect(genB).not.toBe(genA);
		const pointer2 = JSON.parse(readFileSync(`${venv}.current`, "utf8"));
		expect(pointer2.current).toBe(basename(genB));
		expect(pointer2.previous).toBe(basename(genA));
		expect(getKernelVenvDir()).toBe(genB);
		expect(existsSync(join(genA, "bin", "python"))).toBe(true);
	});

	it("leaves a published generation intact and does not rerun uv when it later fails readiness", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		// Build and publish a real generation.
		await ensureKernelPython();
		const gen = liveGenerationDir();
		const genPython = join(gen, "bin", "python");
		expect(existsSync(genPython)).toBe(true);
		writeFileSync(join(gen, "CANARY"), "live");
		const uvLogAfterBuild = readFileSync(logPath, "utf8");

		// Its readiness probe now fails (an OOM-killed / ENOMEM probe under memory pressure):
		// the interpreter is present but the readiness check exits non-zero.
		writeExecutable(
			genPython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);

		await expect(ensureKernelPython()).rejects.toThrow(/failed its readiness probe/);
		// The live dir and its contents survive; no rm, and uv did not run again.
		expect(existsSync(genPython)).toBe(true);
		expect(readFileSync(join(gen, "CANARY"), "utf8")).toBe("live");
		expect(getKernelVenvDir()).toBe(gen);
		expect(readFileSync(logPath, "utf8")).toBe(uvLogAfterBuild);
	});

	it("reuses an existing base-ready generation on rollback (A -> B -> A) with no uv rerun or rm", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;
		const venvBuilds = (log: string) => log.split("\n").filter((line) => line.startsWith("venv ")).length;

		// Build generation A.
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		await ensureKernelPython();
		const genA = liveGenerationDir();
		writeFileSync(join(genA, "CANARY"), "A");

		// Build generation B (a runtime change).
		writeRuntimeSource(runtimeSource, "spawn = 2\n");
		await ensureKernelPython();
		const genB = liveGenerationDir();
		expect(genB).not.toBe(genA);
		const buildsBefore = venvBuilds(readFileSync(logPath, "utf8"));

		// Roll back to A: it must be re-published, not rebuilt.
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		const backToA = await ensureKernelPython();
		expect(backToA).toBe(join(genA, "bin", "python"));
		expect(getKernelVenvDir()).toBe(genA);
		// A (and its canary) is intact -- never removed and never rebuilt; B survives too.
		expect(readFileSync(join(genA, "CANARY"), "utf8")).toBe("A");
		expect(existsSync(join(genB, "bin", "python"))).toBe(true);
		// No new uv `venv` build ran for the rollback (zero uv builds).
		expect(venvBuilds(readFileSync(logPath, "utf8"))).toBe(buildsBefore);
		// A is live again with B kept as the rollback previous.
		const pointer = JSON.parse(readFileSync(`${venv}.current`, "utf8"));
		expect(pointer.current).toBe(basename(genA));
		expect(pointer.previous).toBe(basename(genB));
	});

	it("keeps a just-published generation and a valid pointer when post-publish marker cleanup throws", async () => {
		// Regression for the post-publication deletion / build-and-delete boot loop: publishGeneration
		// + clearBootstrapFailure used to run inside the try whose catch rm'd the build dir, so a
		// non-ENOENT marker rm failure deleted the just-published generation and dangled the pointer.
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;

		// Build and publish generation A.
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		await ensureKernelPython();
		const genA = liveGenerationDir();
		writeFileSync(join(genA, "CANARY"), "A");

		// A runtime change forces a fresh generation B. Inject a post-publish cleanup failure by
		// making the backoff-marker path a DIRECTORY, so clearBootstrapFailure's rm(force:true, no
		// recursive) throws EISDIR after the pointer already names the new generation.
		writeRuntimeSource(runtimeSource, "spawn = 2\n");
		mkdirSync(`${venv}.bootstrap-failed`);

		// Publication is irreversible, so the boot still succeeds and does NOT delete B.
		const built = await ensureKernelPython();
		const genB = liveGenerationDir();
		expect(genB).not.toBe(genA);
		expect(built).toBe(join(genB, "bin", "python"));

		// The just-published generation survives with a valid pointer; A survives too.
		expect(existsSync(join(genB, "bin", "python"))).toBe(true);
		expect(getKernelVenvDir()).toBe(genB);
		const pointer = JSON.parse(readFileSync(`${venv}.current`, "utf8"));
		expect(pointer.current).toBe(basename(genB));
		expect(existsSync(join(genA, "bin", "python"))).toBe(true);
		expect(readFileSync(join(genA, "CANARY"), "utf8")).toBe("A");
	});

	it("runKernelPrebuild builds the named venv family and publishes it", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv-prod");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		await runKernelPrebuild({ requireNamedVenv: true });

		const gen = getKernelVenvDir();
		expect(gen).toMatch(new RegExp(`^${venv}-[0-9a-f]{16}-[0-9a-f]{32}$`));
		expect(existsSync(join(gen, "bin", "python"))).toBe(true);
		expect(readFileSync(logPath, "utf8")).toContain(`venv ${gen} --python 3.11 --seed`);
		const pointer = JSON.parse(readFileSync(`${venv}.current`, "utf8"));
		expect(pointer.current).toBe(basename(gen));
	});

	it("runKernelPrebuild without requireNamedVenv prebuilds the DEFAULT family and exits 0 with no named venv (M8)", async () => {
		const logPath = installFakeUv();
		// HOME is the sandbox (beforeEach); no PRIME_AGENT_KERNEL_VENV. This is the native-installer /
		// public-flag path with PRIME_AGENT_KERNEL_VENV_REQUIRED unset: warn + build the default family.
		const runtimeSource = join(tempDir, "runtime-src");
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;
		mkdirSync(join(tempDir, ".prime", "agent"), { recursive: true });
		delete process.env.PRIME_AGENT_KERNEL_VENV;

		await runKernelPrebuild({ requireNamedVenv: false });

		const gen = getKernelVenvDir();
		expect(gen).toMatch(/kernel-venv-[0-9a-f]{16}-[0-9a-f]{32}$/);
		expect(existsSync(join(gen, "bin", "python"))).toBe(true);
		expect(readFileSync(logPath, "utf8")).toContain("venv ");
	});

	it("runKernelPrebuild with requireNamedVenv rejects a missing PRIME_AGENT_KERNEL_VENV", async () => {
		installFakeUv();
		delete process.env.PRIME_AGENT_KERNEL_VENV;

		await expect(runKernelPrebuild({ requireNamedVenv: true })).rejects.toThrow(
			/PRIME_AGENT_KERNEL_VENV must be set/,
		);
	});

	it("runKernelPrebuild rejects a conflicting PRIME_AGENT_KERNEL_PYTHON override", async () => {
		installFakeUv();
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv-prod");
		process.env.PRIME_AGENT_KERNEL_PYTHON = join(tempDir, "override-python");

		await expect(runKernelPrebuild({ requireNamedVenv: true })).rejects.toThrow(
			/PRIME_AGENT_KERNEL_PYTHON conflicts with a kernel prebuild/,
		);
	});

	it("opt-in GC removes only superseded same-family generations and keeps current/previous and sibling families", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const runtimeSource = join(tempDir, "runtime-src");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = runtimeSource;

		// Build A then B, so the pointer keeps current=B, previous=A.
		writeRuntimeSource(runtimeSource, "spawn = 1\n");
		await ensureKernelPython();
		const genA = liveGenerationDir();
		writeRuntimeSource(runtimeSource, "spawn = 2\n");
		await ensureKernelPython();
		const genB = liveGenerationDir();
		expect(genB).not.toBe(genA);

		// A superseded same-family generation, aged past the GC grace window.
		const oldGen = `${venv}-${"a".repeat(16)}-${"b".repeat(32)}`;
		mkdirSync(join(oldGen, "bin"), { recursive: true });
		writeFileSync(join(oldGen, "CANARY"), "old");
		const aged = new Date(Date.now() - 2 * 60 * 60_000);
		utimesSync(oldGen, aged, aged);

		// A sibling family the exact family regex must never touch.
		const sibling = `${venv}-prod-0123456789abcdef`;
		mkdirSync(join(sibling, "bin"), { recursive: true });
		writeFileSync(join(sibling, "CANARY"), "keep");
		utimesSync(sibling, aged, aged);

		// Re-run the prebuild with opt-in GC. It reuses B (no rebuild) then GC's superseded gens.
		process.env.PRIME_AGENT_KERNEL_VENV_GC = "1";
		await runKernelPrebuild({ requireNamedVenv: true });

		// The superseded same-family generation is reclaimed; current/previous and the sibling survive.
		expect(existsSync(oldGen)).toBe(false);
		expect(existsSync(join(genA, "bin", "python"))).toBe(true);
		expect(existsSync(join(genB, "bin", "python"))).toBe(true);
		expect(readFileSync(join(sibling, "CANARY"), "utf8")).toBe("keep");
	});

	it("a default-base ensure never touches a sibling venv family", async () => {
		const logPath = installFakeUv();
		// This process uses the DEFAULT base (no PRIME_AGENT_KERNEL_VENV); HOME is the sandbox.
		const agentDir = join(tempDir, ".prime", "agent");
		mkdirSync(agentDir, { recursive: true });
		// A prod family and a "next" sibling that a loose prefix match would have deleted.
		const prodGen = join(agentDir, "kernel-venv-prod-0123456789abcdef");
		const prodBase = join(agentDir, "kernel-venv-prod");
		const nextSibling = join(agentDir, "kernel-venv-next");
		for (const dir of [prodGen, prodBase, nextSibling]) {
			mkdirSync(join(dir, "bin"), { recursive: true });
			writeFileSync(join(dir, "CANARY"), "keep");
		}

		// A full default-base build + publish (in-band GC is disabled).
		await ensureKernelPython();
		expect(readFileSync(logPath, "utf8")).toContain("venv ");

		// Every sibling family survives untouched.
		for (const dir of [prodGen, prodBase, nextSibling]) {
			expect(readFileSync(join(dir, "CANARY"), "utf8")).toBe("keep");
		}
	});

	it("uses PRIME_AGENT_KERNEL_PYTHON as an override contract", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).resolves.toBe(overridePython);
	});

	it("allows PRIME_AGENT_KERNEL_PYTHON missing Python skill imports", async () => {
		const overridePython = join(tempDir, "override-python");
		const pythonSkill = createPythonSkill();
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython({ pythonSkills: [pythonSkill] })).resolves.toBe(overridePython);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON missing default extra packages", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((name) => name !== "yaml")]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/default Python packages \(yaml \(PyYAML\)\)/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a stale rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, ["dill"]);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.spawn/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a legacy harness API", async () => {
		const overridePython = join(tempDir, "override-python");
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				'    *"_harness_methods"*) exit 1 ;;',
				"    *\"assert not hasattr(rlm.rlm, 'background')\"*) exit 0 ;;",
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/current prime-agent-runtime with callable rlm\.spawn/);
	});

	it("rejects PRIME_AGENT_KERNEL_PYTHON with a pre-progress-note rlm runtime", async () => {
		const overridePython = join(tempDir, "override-python");
		// An rlm runtime older than rlm.progress_note: it satisfies every
		// earlier readiness probe but fails any check that asserts the new
		// API (regression: the readiness check skipped progress_note, so the
		// doctrine's advertised call hit AttributeError mid-run instead of
		// failing fast here).
		writeExecutable(
			overridePython,
			[
				"#!/bin/sh",
				'if [ "$1" = "-c" ]; then',
				'  case "$2" in',
				'    "import rlm") exit 0 ;;',
				'    *"progress_note"*) exit 1 ;;',
				'    *"_harness_methods"*) exit 0 ;;',
				"    *) exit 1 ;;",
				"  esac",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(
			/current prime-agent-runtime with callable rlm\.spawn, rlm\.create_session, rlm\.host_request, rlm\.progress_note/,
		);
	});

	it("fails an invalid PRIME_AGENT_KERNEL_PYTHON without bootstrapping", async () => {
		const overridePython = join(tempDir, "override-python");
		writeFakePython(overridePython, []);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;

		await expect(ensureKernelPython()).rejects.toThrow(/PRIME_AGENT_KERNEL_PYTHON points to a Python missing/);
	});

	it("resolves the venv python under Scripts\\python.exe on win32 (uv layout)", () => {
		const venv = join(tempDir, "kernel-venv");
		expect(kernelVenvPython(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(kernelVenvPython(venv, "linux")).toBe(join(venv, "bin", "python"));
	});
});
