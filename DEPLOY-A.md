# DEPLOY A - Freeze remediation, containment + trigger fixes (branch: fix/deploy-a-freeze-remediation)

Goal: make a repeat of the 2026-09-15 host freeze BOTH far less likely AND recoverable-not-silent,
WITHOUT changing the owner's usage (continuous one-conversation runs, heartbeats, large subagent trees).
This is the FIRST of three deploys. It is BUILD-ONLY here: nothing in this branch may restart the prod
daemon, rebuild the prod venv, or apply host config live. Test only in prime-next with an ISOLATED
PRIME_AGENT_KERNEL_VENV and a separate socket. The live cutover is a later, human-gated step.

Root cause (verified): the v0.9.1->v0.9.4 upgrade forced a kernel-venv rebuild storm and deploy churn;
the hard freeze was host memory/swap exhaustion under the user-400.slice MemoryHigh=50G SOFT throttle
(MemoryMax=infinity), with earlyoom never firing. Daemon+kernels run in the SSH login scope (session-3.scope).

HARD RULES for every change:
- No em-dashes or en-dashes anywhere (code, comments, docs). Plain hyphen only.
- Small, reviewable, reversible commits, one component per commit, with a clear message.
- After each component: `cd packages/coding-agent && npm run build` must exit 0; run the targeted vitest
  files named below; `npx biome check --write packages/coding-agent/src/<changed files>` clean.
- Do NOT edit files outside the component's listed targets. Do NOT touch prod (/mnt/devvm/custom/prime).
- Preserve existing behavior for the non-targeted paths; add, do not rewrite subsystems.

======================================================================
A.2  FULL F1 - non-destructive kernel-venv rebuild (LINCHPIN)
======================================================================
Files: packages/coding-agent/src/core/kernel/bootstrap.ts, bootstrap-cli.ts (+ getKernelVenvDir callers).
Problem: ensureKernelPythonUncached does `if (hadVenv) rm(venv, {recursive,force})` then bootstrapVenv();
on any failure the catch only rethrows -> the shared venv is deleted and every later kernel repeats the
failing full rebuild (the freeze-day cascade). #2203 (PORT IT FIRST as the base) only fixes the
missing-SOURCE case; the identity-change rebuild path (runtime hash over rlm/**/*.py + pyproject, or a
RUNTIME_READY_CHECK change) still rm-then-rebuilds.
Change (generation + pointer + backoff, do NOT rename a built venv - uv writes absolute shebangs):
 1) PORT upstream PR #2203 as the base (resolve+hash runtime source BEFORE touching the venv; fail clean
    leaving the existing venv untouched when source is missing; drop the registry-name fallback; add
    PRIME_AGENT_RUNTIME_SOURCE; append uv/python stderr tail to failures).
 2) Build each venv into a VERSIONED sibling dir on the SAME filesystem: kernel-venv-<identityHash>
    (identity = existing runtime+skills identity). Validate kernelReady() in that dir, THEN atomically
    publish by writing/replacing a small pointer file that getKernelVenvDir() reads (B:370-374). Never
    rm the live venv before the new one is validated. Keep previous generations until no live kernel
    imports from them (best-effort: leave the immediately-previous generation for rollback; GC older).
 3) On rebuild failure: leave the existing good generation in place; write a .bootstrap-failed marker
    (sibling file, NOT inside a venv) keyed by identity with fields {identity, attempt, nextRetryAt};
    exponential backoff 1,2,4..30 min; waiters fail fast via formatBootstrapFailure until nextRetryAt.
    A new/changed identity clears/bypasses the marker (a real code change retries immediately).
 4) Keep the existing sibling mkdir bootstrap lock; recheck readiness inside it.
 5) bootstrap-cli.ts: ensure `prime-agent --prime-agent-bootstrap` builds a SPECIFIED PRIME_AGENT_KERNEL_VENV
    path (deploy-time prebuild), prints the resolved identity + path, exits non-zero on failure (deploy blocker),
    and NEVER touches a venv other than the one named by PRIME_AGENT_KERNEL_VENV.
Acceptance: unit tests that (a) a simulated bootstrapVenv failure leaves the previous generation intact and
sets the marker; (b) a second attempt before nextRetryAt fails fast without running uv; (c) an identity
change bypasses the marker; (d) atomic publish is a single pointer write. Tests: test/kernel-bootstrap*.test.ts
(add if absent) + `tsx src/core/kernel/bootstrap-cli.ts` against a temp PRIME_AGENT_KERNEL_VENV.

======================================================================
A.3  F10 - lifecycle-aware worker ownership + stale-descriptor cleanup
======================================================================
File: packages/coding-agent/src/modes/daemon/daemon-supervisor.ts.
Problem: findWorkerBySessionFile (S:5111-5135) matches ANY lifecycle, so a failed/dead descriptor makes
uncoveredRootFor (S:979-995) treat its root as COVERED -> scheduled wakes silently skip it; and 7 such
descriptors currently block prepareUpdateRestartFenced (S:6417-6424) forcing cold restarts.
Change (SPLIT ownership from wake-eligibility; do NOT blanket ready-only filter - a live-but-unreachable
owner still owns):
 1) Separate three predicates: (a) OWNS the session path (includes starting/stopping/identity-verified
    live-failed workers) - unchanged for ownership decisions; (b) can be WOKEN now (excludes
    failed/stopping/dead lifecycles); (c) confirmed dead+unowned -> safe to remove.
 2) uncoveredRootFor / the wake scan must use predicate (b): a failed/gone descriptor must NOT count as
    coverage, so the root becomes wake-eligible.
 3) At adoption/recovery, when processIdentity is confirmed gone/replaced AND the worker is unowned,
    remove the stale descriptor via the existing reclaim path (S:6800-6805), identity-verified only.
 4) Keep unresolved live ownership FAIL-CLOSED (do not reclaim a live-but-unreachable worker).
Acceptance: a failed descriptor with a dead pid no longer masks its root from uncoveredRootFor; a
confirmed-dead unowned descriptor is removed; a live-but-unreachable worker is NOT removed;
prepareUpdateRestartFenced proceeds when all remaining descriptors are ready or reclaimable.
Tests: test/daemon-supervisor*.test.ts (add cases).

======================================================================
A.4  R4 sibling - supervisor-replacement probe hardening
======================================================================
File: packages/coding-agent/src/modes/daemon/daemon-mode.ts.
Problem: checkSupervisorAvailability launches launchReplacementSupervisor (M:870, M:1020-1062) on the FIRST
failed 250ms raw TCP probe (M:1000-1018); it fired on freeze day and can spawn a second full daemon.
Also worker self-exit (M:283-289, 853-911) fires on the same weak probe.
Change:
 1) Require N>=3 CONSECUTIVE failed probes over a longer window (probe timeout 2-5s, not 250ms) before
    considering the supervisor lost.
 2) Do NOT launchReplacementSupervisor while the supervisor OWNERSHIP record pid/generation is alive
    (check the ownership record, not just a socket connect).
 3) Leave PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS as the operator knob (0 = immediate; a large
    value effectively disables self-exit until Deploy B lands completion-based termination). Document it.
Acceptance: a single transient probe failure does not trigger a replacement spawn or self-exit; a replacement
is never spawned while the ownership pid is alive.
Tests: test/daemon-mode*.test.ts (add cases) or a focused unit around the probe/exit predicate.

======================================================================
A.5  Lazy kernel prewarm (single biggest probability reducer)
======================================================================
File: packages/coding-agent/src/core/agent-session.ts (~AS:10254-10262 hasSnapshot -> prewarm()).
Problem: hydrating a snapshot-bearing session EAGERLY starts a Python kernel and restores the pickle, on
heartbeat fire, agent message to a passive child (M:6374-6382), parent access, and wake. This is the memory
generator that turns any wave into GB of kernel state.
Change: gate eager prewarm behind (a) an env/config switch AND (b) interactive/attached sessions only;
for daemon-hydrated (non-attached) sessions, DEFER kernel start until the first actual ipython use (restore
the snapshot lazily on first kernel need). Do not change interactive behavior.
Acceptance: a daemon hydration of a passive snapshot-bearing child does NOT spawn a Python kernel until a
Python tool is used; interactive attach still prewarms. Tests: test around the hydration path / repl-manager.

======================================================================
A.1  Host + launcher scope (config + launcher; NOT applied live here)
======================================================================
Files: the daemon launcher/spawn path (cli-main.ts / daemon-launch.ts createCliSubprocessLaunchSpec) +
new deploy/ config artifacts under a new deploy/deploy-a/ dir (systemd scope unit or systemd-run wrapper,
earlyoom drop-in, env file). PRODUCE FILES + a runbook; DO NOT apply to the host.
Change:
 1) Launcher: when starting the daemon, wrap the spawn in a dedicated cgroup scope
    (systemd-run --user --scope -p MemoryMax=<measured> -p MemorySwapMax=<few GB> -p Delegate=yes) so the
    supervisor + all workers + kernels + uv helpers inherit it, and a shell-driven restart cannot drop the
    daemon back into the SSH session scope. Gate behind an env flag (PRIME_AGENT_DAEMON_SCOPE=1) so it is
    opt-in and reversible. If systemd-run is unavailable, fall back to today's behavior with a logged warning.
 2) deploy/deploy-a/ artifacts (as files + a README runbook, NOT applied):
    - a systemd --user scope/unit template with MemoryMax (start HIGH, ~44-48 GiB) + MemorySwapMax (4-8 GiB)
      + memory.oom.group=0, and a note to REMOVE/raise user-400.slice MemoryHigh (the soft cap that IS the freeze).
    - earlyoom drop-in retuned for 64G swap with ABSOLUTE thresholds (-M/-S in KiB) and regexes fixed to the
      REAL comms (daemon=prime-agent, kernel=python); note earlyoom -g; VERIFIED today the shipped
      --prefer node/--avoid python3 match NOTHING of ours.
    - env file documenting: PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS=2, PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS=<large>,
      per-checkout PRIME_AGENT_KERNEL_VENV, PRIME_AGENT_RUNTIME_SOURCE.
    - a supervisor crash-loop breaker note (N recoveries of the same worker in M minutes -> park+alert)
      to be implemented in Deploy B, referenced here.
    - lightweight telemetry: event-loop lag, collectPassiveScheduledJobs/flushRoster durations,
      worker+kernel counts, cgroup memory.current/swap.current (a small sampler; may be a separate script).
Acceptance: the launcher scope is opt-in, reversible, and falls back cleanly; the deploy/deploy-a/ runbook
is complete enough to execute the cutover by hand under a health gate. NO host mutation from this branch.

======================================================================
Definition of done for Deploy A (build phase)
======================================================================
- All five components committed on fix/deploy-a-freeze-remediation, each `npm run build` exit 0, biome clean,
  targeted tests pass.
- A DEPLOY-A-RUNBOOK.md describing the health-gated cutover (prebuild venv, clear the 7 stale descriptors via
  the recover-failed-daemon-worker procedure, apply scope+earlyoom+env, then update-restart), and rollback
  (previous venv generation + previous build).
- No prod mutation, no live restart, no shared-venv rebuild. Test only in prime-next on an isolated venv+socket.
