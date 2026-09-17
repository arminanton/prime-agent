import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
} from "../src/core/kernel/bootstrap.js";

const execFileAsync = promisify(execFile);

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
		originalEnv = { ...process.env };
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-bootstrap-"));
		process.env.HOME = tempDir;
		process.env.PATH = originalEnv.PATH ?? "";
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		delete process.env.PRIME_AGENT_KERNEL_VENV;
		delete process.env.XDG_DATA_HOME;
		delete process.env.PRIME_AGENT_KERNEL_VENV_FORCE_REBUILD;
		delete process.env.UV_FAIL_ARG;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = join(tempDir, "prime-agent-runtime");
		writeRuntimeSource(process.env.PRIME_AGENT_RUNTIME_SOURCE, "runtime = 1\n");
		runtimeIdentity = await resolveRuntimeIdentity();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env = originalEnv;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("leaves a stale venv intact when runtime sources are missing (#2203)", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		writeFakePython(python, ["rlm"]);
		writeFileSync(join(venv, ".bootstrap-version"), "stale manifest");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		process.env.PRIME_AGENT_RUNTIME_SOURCE = join(tempDir, "missing-runtime");

		await expect(ensureKernelPython()).rejects.toThrow(/prime-agent-runtime source .* is missing/);

		expect(readFileSync(join(venv, ".bootstrap-version"), "utf8")).toBe("stale manifest");
		expect(existsSync(python)).toBe(true);
		expect(existsSync(logPath)).toBe(false);
	});

	it("replaces a stale venv without deleting files used by running kernels (#2203)", async () => {
		installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		mkdirSync(venv);
		writeFileSync(join(venv, "in-use"), "keep");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython();

		expect(readFileSync(join(venv, "in-use"), "utf8")).toBe("keep");
		expect(getKernelVenvDir()).not.toBe(venv);
		expect(python).toBe(kernelVenvPython(getKernelVenvDir()));
	});

	it("retains generations across upgrades, cleanup errors and rollback (#2203)", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const first = await ensureKernelPython();
		const firstDir = getKernelVenvDir();
		writeFileSync(join(firstDir, "in-use"), "keep");

		writeRuntimeSource(process.env.PRIME_AGENT_RUNTIME_SOURCE!, "runtime = 2\n");
		// A directory makes post-publication marker removal fail with EISDIR.
		mkdirSync(`${venv}.bootstrap-failed`);
		const second = await ensureKernelPython();
		const secondDir = getKernelVenvDir();
		expect(second).not.toBe(first);
		expect(existsSync(second)).toBe(true);
		expect(JSON.parse(readFileSync(`${venv}.current`, "utf8"))).toMatchObject({
			current: basename(secondDir),
			previous: basename(firstDir),
		});

		const log = readFileSync(logPath, "utf8");
		writeRuntimeSource(process.env.PRIME_AGENT_RUNTIME_SOURCE!, "runtime = 1\n");
		await expect(ensureKernelPython()).resolves.toBe(first);
		expect(readFileSync(join(firstDir, "in-use"), "utf8")).toBe("keep");
		expect(existsSync(second)).toBe(true);
		expect(readFileSync(logPath, "utf8")).toBe(log);
		expect(JSON.parse(readFileSync(`${venv}.current`, "utf8"))).toMatchObject({
			current: basename(firstDir),
			previous: basename(secondDir),
		});
	});

	it("keeps the published generation and backs off after a failed build (#2203)", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const first = await ensureKernelPython();
		const firstDir = getKernelVenvDir();
		writeRuntimeSource(process.env.PRIME_AGENT_RUNTIME_SOURCE!, "runtime = 2\n");
		process.env.UV_FAIL_ARG = "dill";

		await expect(ensureKernelPython()).rejects.toThrow(/failed with exit code 1\nfake uv: refusing to install dill/);
		expect(getKernelVenvDir()).toBe(firstDir);
		expect(existsSync(first)).toBe(true);
		expect(readdirSync(dirname(venv)).filter((name) => name.startsWith(`${basename(venv)}-`))).toEqual([
			basename(firstDir),
		]);
		const marker = JSON.parse(readFileSync(`${venv}.bootstrap-failed`, "utf8"));
		expect(marker).toMatchObject({ identity: bootstrapGenerationHash(await resolveRuntimeIdentity()), attempt: 1 });
		const log = readFileSync(logPath, "utf8");
		await expect(ensureKernelPython()).rejects.toThrow(/not rebuilding again before/);
		expect(readFileSync(logPath, "utf8")).toBe(log);

		vi.spyOn(Date, "now").mockReturnValue(marker.nextRetryAt);
		await expect(ensureKernelPython()).rejects.toThrow(/failed with exit code 1\nfake uv: refusing to install dill/);
		const retried = JSON.parse(readFileSync(`${venv}.bootstrap-failed`, "utf8"));
		expect(retried).toMatchObject({ attempt: 2, nextRetryAt: marker.nextRetryAt + 120_000 });

		delete process.env.UV_FAIL_ARG;
		writeRuntimeSource(process.env.PRIME_AGENT_RUNTIME_SOURCE!, "runtime = 3\n");
		const changed = await ensureKernelPython();
		expect(changed).not.toBe(first);
		expect(existsSync(changed)).toBe(true);
		expect(existsSync(`${venv}.bootstrap-failed`)).toBe(false);
	});

	it("leaves a matching generation intact when its readiness probe fails (#2203)", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const python = await ensureKernelPython();
		const generation = getKernelVenvDir();
		const log = readFileSync(logPath, "utf8");
		writeFakePython(python, []);
		const contents = readFileSync(python, "utf8");

		await expect(ensureKernelPython()).rejects.toThrow(/failed its readiness probe/);
		expect(getKernelVenvDir()).toBe(generation);
		expect(readFileSync(python, "utf8")).toBe(contents);
		expect(readFileSync(logPath, "utf8")).toBe(log);
		expect(existsSync(`${venv}.bootstrap-failed`)).toBe(false);

		// Packaged installs can remove just the pointer, without a bootstrap CLI or deleting a live venv.
		rmSync(`${venv}.current`);
		const recovered = await ensureKernelPython();
		expect(recovered).not.toBe(python);
		expect(existsSync(recovered)).toBe(true);
		expect(readFileSync(python, "utf8")).toBe(contents);
	});

	it("does not merge a forced rebuild into an ordinary ensure (#2203)", async () => {
		installFakeUv();
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "kernel-venv");
		const first = await ensureKernelPython();
		const [reused, rebuilt] = await Promise.all([ensureKernelPython(), ensureKernelPython({ forceRebuild: true })]);
		expect(reused).toBe(first);
		expect(rebuilt).not.toBe(first);
		expect(existsSync(first)).toBe(true);
		expect(existsSync(rebuilt)).toBe(true);
	});

	it("honors force rebuild only in the one-shot bootstrap CLI (#2203)", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;
		const first = await ensureKernelPython();
		const log = readFileSync(logPath, "utf8");
		process.env.PRIME_AGENT_KERNEL_VENV_FORCE_REBUILD = "1";
		await expect(ensureKernelPython()).resolves.toBe(first);
		expect(readFileSync(logPath, "utf8")).toBe(log);

		const cli = fileURLToPath(new URL("../src/core/kernel/bootstrap-cli.ts", import.meta.url));
		await execFileAsync(process.execPath, ["--import", "tsx", cli]);
		const second = kernelVenvPython(getKernelVenvDir());
		expect(second).not.toBe(first);
		expect(existsSync(first)).toBe(true);
		expect(existsSync(second)).toBe(true);
	});

	it.each(["../other", "kernel-venv-other-0123456789abcdef", "kernel-venv-0123456789abcdef-invalid"])(
		"ignores a generation pointer outside its family: %s (#2203)",
		(current) => {
			const venv = join(tempDir, "venvs", "kernel-venv");
			mkdirSync(dirname(venv), { recursive: true });
			mkdirSync(join(dirname(venv), current), { recursive: true });
			process.env.PRIME_AGENT_KERNEL_VENV = venv;
			writeFileSync(`${venv}.current`, JSON.stringify({ current }));
			expect(getKernelVenvDir()).toBe(venv);
		},
	);

	it("bootstraps a missing venv with uv, the runtime, extras and editable Python skills", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const pythonSkill = createPythonSkill();
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython({ pythonSkills: [pythonSkill] });
		const generation = getKernelVenvDir();
		expect(python).toBe(kernelVenvPython(generation));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain("python install 3.11");
		expect(log).toContain(`venv ${generation} --python 3.11 --seed`);
		expect(log).toContain("pip install --python");
		expect(log).not.toContain("ipykernel");
		expect(log).toContain("prime-agent-runtime");
		expect(log).toContain("dill");
		expect(log).toContain(`--editable ${pythonSkill.packagePath}`);
		for (const uvArg of DEFAULT_RLM_EXTRA_UV_ARGS) {
			expect(log).toContain(uvArg);
		}

		// The on-disk manifest is what every later warm-start decision reads.
		const version = JSON.parse(readFileSync(join(generation, ".bootstrap-version"), "utf8"));
		expect(version).toEqual({
			schema: 9,
			runtime: runtimeIdentity,
			snapshot: "dill",
			extraUvArgs: DEFAULT_RLM_EXTRA_UV_ARGS,
			generation: bootstrapGenerationHash(runtimeIdentity),
			pythonSkills: [
				{
					importName: pythonSkill.importName,
					packagePath: pythonSkill.packagePath,
					pyprojectPath: pythonSkill.pyprojectPath,
					pyprojectHash: pyprojectHash(pythonSkill.pyprojectPath),
				},
			],
		});
		expect(version.runtime).toMatch(/^sha256:/);
	});

	it.each([
		{ name: "a sibling skill directory", packageName: undefined, dependency: "attach-image" },
		{
			name: "a sibling whose package and directory names differ",
			packageName: "prime-agent-skill-attach-image",
			dependency: "prime-agent-skill-attach-image",
		},
		{
			name: "a dependency declared with extras and a version bound",
			packageName: undefined,
			dependency: "attach-image[httpx]>4.0.0",
		},
	])("installs $name as an editable package", async ({ packageName, dependency }) => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const dependencySkill = createPythonSkill("attach-image");
		if (packageName) {
			writeFileSync(dependencySkill.pyprojectPath, `[project]\nname = "${packageName}"\nversion = "0.1.0"\n`);
		}
		const dependentSkill = createPythonSkillWithDependency("orchestration-heartbeat", dependency);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const python = await ensureKernelPython({ pythonSkills: [dependentSkill] });
		expect(python).toBe(kernelVenvPython(getKernelVenvDir()));

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

		const python = await ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] });
		const generation = getKernelVenvDir();
		expect(python).toBe(kernelVenvPython(generation));

		const log = readFileSync(logPath, "utf8");
		expect(log).toContain(`--editable ${goodSkill.packagePath}`);
		expect(log).toContain(`--editable ${brokenSkill.packagePath}`);
		const version = JSON.parse(readFileSync(join(generation, ".bootstrap-version"), "utf8"));
		expect(version.pythonSkills).toEqual([
			{
				importName: goodSkill.importName,
				packagePath: goodSkill.packagePath,
				pyprojectPath: goodSkill.pyprojectPath,
				pyprojectHash: pyprojectHash(goodSkill.pyprojectPath),
			},
		]);

		await expect(ensureKernelPython({ pythonSkills: [goodSkill, brokenSkill] })).resolves.toBe(python);

		const retryLog = readFileSync(logPath, "utf8");
		expect(retryLog.split("\n").filter((line) => line.startsWith(`venv ${generation} `))).toHaveLength(1);
		expect(
			retryLog.split("\n").filter((line) => line.includes(`--editable ${brokenSkill.packagePath}`)),
		).toHaveLength(2);
	});

	it("shares concurrent bootstrap work in one process", async () => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const results = await Promise.all([ensureKernelPython(), ensureKernelPython()]);
		const generation = getKernelVenvDir();
		expect(results).toEqual([kernelVenvPython(generation), kernelVenvPython(generation)]);

		const log = readFileSync(logPath, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith(`venv ${generation} `))).toHaveLength(1);
	});

	it.each([
		{
			name: "reuses a current warm venv without invoking uv",
			rebuilds: false,
			prepare: (venv: string, python: string) => {
				writeFakePython(python, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]);
				writeBootstrapVersion(venv);
			},
		},
		{
			name: "rebuilds when the recorded runtime hash no longer matches local source",
			rebuilds: true,
			prepare: (venv: string, python: string) => {
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
			},
		},
		{
			name: "rebuilds a legacy unhashed Python skill manifest",
			rebuilds: true,
			prepare: (venv: string, python: string) => {
				const pythonSkill = createPythonSkill();
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
			},
		},
		{
			name: "rebuilds a venv whose interpreter is missing entirely",
			rebuilds: true,
			prepare: (venv: string) => {
				writeBootstrapVersion(venv);
			},
		},
	])("$name", async ({ rebuilds, prepare }) => {
		const logPath = installFakeUv();
		const venv = join(tempDir, "kernel-venv");
		const python = join(venv, "bin", "python");
		mkdirSync(join(venv, "bin"), { recursive: true });
		prepare(venv, python);
		process.env.PRIME_AGENT_KERNEL_VENV = venv;

		const result = await ensureKernelPython();
		const generation = getKernelVenvDir();
		expect(result).toBe(rebuilds ? kernelVenvPython(generation) : python);

		// A warm venv that needs no work never runs uv, so the log may not exist at all.
		const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
		expect(log.includes(`venv ${generation} --python 3.11 --seed`)).toBe(rebuilds);
		if (rebuilds) {
			expect(JSON.parse(readFileSync(join(generation, ".bootstrap-version"), "utf8")).runtime).toBe(runtimeIdentity);
		}
	});

	it.each([
		{
			name: "accepts an interpreter carrying the runtime and every default extra",
			write: (path: string) => writeFakePython(path, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]),
			withSkill: false,
			error: undefined,
		},
		{
			name: "accepts an interpreter that cannot import the Python skills",
			write: (path: string) => writeFakePython(path, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES]),
			withSkill: true,
			error: undefined,
		},
		{
			name: "rejects an interpreter missing a default extra package",
			write: (path: string) =>
				writeFakePython(path, ["rlm", ...DEFAULT_RLM_EXTRA_IMPORT_NAMES.filter((module) => module !== "yaml")]),
			withSkill: false,
			error: /default Python packages \(yaml \(PyYAML\)\)/,
		},
		{
			name: "rejects an interpreter with a stale rlm runtime",
			write: (path: string) => writeFakePython(path, ["dill"]),
			withSkill: false,
			error: /current prime-agent-runtime with callable rlm\.spawn/,
		},
		{
			name: "rejects an interpreter exposing only the legacy harness API",
			write: (path: string) =>
				writeExecutable(
					path,
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
				),
			withSkill: false,
			error: /current prime-agent-runtime with callable rlm\.spawn/,
		},
		{
			name: "rejects an interpreter with a pre-progress-note rlm runtime",
			write: (path: string) =>
				writeExecutable(
					path,
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
				),
			withSkill: false,
			error: /current prime-agent-runtime with callable rlm\.spawn, rlm\.create_session, rlm\.host_request, rlm\.progress_note/,
		},
		{
			name: "rejects an interpreter missing the runtime, without bootstrapping a venv",
			write: (path: string) => writeFakePython(path, []),
			withSkill: false,
			error: /PRIME_AGENT_KERNEL_PYTHON points to a Python missing/,
		},
	])("PRIME_AGENT_KERNEL_PYTHON $name", async ({ write, withSkill, error }) => {
		const overridePython = join(tempDir, "override-python");
		write(overridePython);
		process.env.PRIME_AGENT_KERNEL_PYTHON = overridePython;
		const options = withSkill ? { pythonSkills: [createPythonSkill()] } : {};

		if (error) {
			await expect(ensureKernelPython(options)).rejects.toThrow(error);
		} else {
			await expect(ensureKernelPython(options)).resolves.toBe(overridePython);
		}
	});

	it("resolves the venv python under Scripts\\python.exe on win32 (uv layout)", () => {
		const venv = join(tempDir, "kernel-venv");
		expect(kernelVenvPython(venv, "win32")).toBe(join(venv, "Scripts", "python.exe"));
		expect(kernelVenvPython(venv, "linux")).toBe(join(venv, "bin", "python"));
	});
});
