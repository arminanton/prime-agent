# DEPLOY A - consolidated fix contract (branch fix/deploy-a-freeze-remediation)

Source: 8 independent reviews (4 second-opinion + 4 adversarial across claude-fable-5.1, gpt-6-astra,
grok-4.6, gemini-3.8-flash). Several A.2 defects are PROVEN by reproduction (see
/home/ndsadmin/prime-v094-freeze-review/deploya-redteam-review.md and /tmp/deploya-review, plus
deploy-a-second-opinion-review.md). Panel verdict: design is right; A.4/A.5 land as-is, A.3 lands with two
fixes, A.2 and A.1 must be reworked. Without R1-R3 and R5 the branch can (a) delete the live venv under
load, (b) delete the prod venv from a default-base run, (c) fail its own update-restart.

RULES (unchanged): work only in /mnt/devvm/custom/prime-next on this branch; NEVER touch prod
(/mnt/devvm/custom/prime) or the shared venv; isolate any kernel/daemon test with a throwaway
PRIME_AGENT_KERNEL_VENV + TMPDIR; commit with `git commit --no-verify` (biome cannot run on this host,
glibc 2.28); validate each change with `cd packages/coding-agent && npm run build` (tsgo) + targeted
isolated vitest; one commit per R-item area; small and reversible; NO em/en dashes anywhere (plain hyphen).
Do a manual dash scan of your diff before each commit.

======================================================================
A.2 FULL F1 - REWORK (linchpin; proven-dangerous). File: src/core/kernel/bootstrap.ts (+ bootstrap-cli.ts, cli/runtime-bootstrap.ts)
======================================================================
R1 (BLOCKER, proven): a same-identity readiness failure must NEVER rm the live/published generation.
  Today generationDir == the published dir for an unchanged identity, and bootstrap.ts:1188-1191 rm's it
  whenever kernelReady/kernelBaseReady is false; hasPrimeAgentRuntime (537-544) is false on ANY run()
  failure (spawn EAGAIN/ENOMEM, python OOM/earlyoom-kill, torn .bootstrap-version, or a TS-only
  RUNTIME_READY_CHECK change). FIX: build every attempt into a UNIQUE sibling `<base>-<identityHash>-<nonce>`,
  validate, then publish the pointer to it (no rename of a built venv); never rm any directory the pointer
  names as current or previous; on a same-identity readiness failure fail clean (write the marker) and
  leave the live venv intact. Test: "published generation fails readiness -> live dir intact, no uv rerun".
R2 (must-fix, proven): reuse an existing base-ready `<base>-<identityHash>*` by PUBLISHING it instead of
  rm+rebuild (fixes rollback/ping-pong A->B->A). FIX: before any build, if kernelBaseReady(candidate) then
  publish + syncPythonSkills + return. Test: "A then B then A reuses A's dir, zero uv calls, no rm".
R3 (BLOCKER, proven): GC must be family-exact. gcOldGenerations (1074-1097) matches the loose prefix
  `<basename>-` and deleted kernel-venv-prod-<hash> AND kernel-venv-next in the repro. FIX: match only
  `^<basename>-[0-9a-f]{16}(-<nonce>)?$`; also validate pointer.current/previous basenames the same way
  before join (453). Prefer: for Deploy A, DISABLE in-band GC entirely (operator/prebuild-time cleanup only)
  unless a real live-reference check exists (dir mtime is build time, not last import; a kernel alive across
  two deploys still imports an "old" gen). Test: "a default-base ensure leaves kernel-venv-prod-<hash> and
  kernel-venv-next intact".
R4 (must-fix): wire the REAL prebuild entrypoint. `prime-agent --prime-agent-bootstrap` runs
  cli-main.ts -> cli/runtime-bootstrap.ts (prints only "kernel python:"), NOT the edited bootstrap-cli.ts.
  FIX: make runRuntimeBootstrap require the named PRIME_AGENT_KERNEL_VENV, reject a conflicting
  PRIME_AGENT_KERNEL_PYTHON override, print "runtime identity:" + "kernel venv:" + "kernel python:", and
  exit non-zero on failure; share one prebuild implementation with bootstrap-cli.ts. Update the runbook
  verification lines to match. Test the actual public flag with fake helpers + an isolated venv path.
SHOULD (fold in where cheap):
- B5 atomic writes (temp+rename) for the pointer, the .bootstrap-failed marker, and writeBootstrapVersion
  (781) - writeFileAtomicSync exists in utils/atomic-file.ts. A torn pointer today falls back to a non-venv base.
- add RUNTIME_READY_CHECK + PYTHON_VERSION to bootstrapGenerationHash (411-419) so those changes make a NEW
  generation instead of a same-identity in-place rebuild.
- B7 update hardcoded base-path callers that will FAIL: test/compiled-artifact.test.ts:385,
  scripts/benchmarks/worker.py:313 and :468, and the stale message at src/core/tools/ipython.ts:45.
- B6 honest GC comment (or keep-N) ; B8 marker message (skills do not retry immediately) ; B9 the 3 #2203 doc rows.
NOTE #2203 port itself is faithful (unanimous) - do not re-port; only add the generation hardening above.

======================================================================
A.3 F10 - LAND WITH FIXES. File: src/modes/daemon/daemon-supervisor.ts
======================================================================
R7 (must-fix): reclaimStaleDeadWorkers must run the existing settling path before deleting a descriptor +
  its journals. removeStaleWorkerDescriptor (5195-5199) skips intentionalStop + recoverUncertainWorkerOperations
  (incl orphan-kernel reaping 4215-4232) + invalidateWorkerSessionInputPauses that reclaimStaleWorkerRegistration
  (3124-3129) performs, yet deleteWorkerDescriptor deletes the orphan journal (1455-1457) -> a worker parked
  failed while alive that later dies leaks its kernels. FIX: make reclaimStaleDeadWorkers async and reuse
  reclaimStaleWorkerRegistration per candidate; broadcastHeartbeatsChanged() when removed>0 and not shutting down.
R8 (must-fix): narrow the coverage predicate to avoid a head-of-line-blocking load regression. A blanket
  "failed -> uncovered" turns a failed-but-ALIVE current worker into a scheduler-driven recovery ladder
  (3x30s) and wakeDueScheduledSessions is SEQUENTIAL, so one wedged live worker blocks every other due
  heartbeat by ~90s under load. Correct coversScheduledWake:
    stopping -> UNcovered; failed AND (gone|replaced) -> UNcovered; failed AND (current|unknown) -> COVERED
    (fail-closed, worker alive); ready AND (gone|replaced) -> UNcovered; ready AND current -> covered.
  This still un-covers the 7 stale failed+gone descriptors (the actual bug) without the blocking. Make
  ready+replaced symmetric with ready+gone.
ALSO (cheap, recommended): rearm the wake scan on coverage loss - recoverWorker parks failed
  (4089-4093/4140-4143) without scheduleScheduledSessionWakeRecompute(); add that call so a newly-uncovered
  root gets a timer immediately (otherwise bounded to ~60s via SCHEDULED_WAKE_RETRY_MS - not a blocker but
  close it). S4 perf: memoize processIdentity per collectPassiveScheduledJobs call (per ready owner per
  ancestor per job today = the known lag hotspot). Keep boot + prepareUpdateRestartFenced reclaim.
  Tests: sole covered root ready->disconnect->failed->due-wake recovers; failed+alive+current does NOT get
  un-covered; reclaim runs cleanup before delete.

======================================================================
A.4 R4 sibling - LAND (small). File: src/modes/daemon/daemon-mode.ts
======================================================================
- Add a unit test that launchReplacementSupervisor returns early when isSupervisorOwnershipAlive is true.
- SHOULD/Deploy B: isSupervisorOwnershipAlive checks only this worker's last-claim generation, so a fresh
  unclaimed worker (supervisor slow) can spawn a short-lived replacement (the acquisition fence still
  prevents a 2nd daemon, so this is churn not correctness). If cheap, add a generation-agnostic current-owner
  lookup by socketPath and fail closed on unresolved; otherwise defer to Deploy B and note it.
- Keep PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS as the operator knob (documented).

======================================================================
A.5 lazy prewarm - LAND (child-only). File: src/core/agent-session.ts
======================================================================
- Narrow all A.5 claims in DEPLOY-A.md + DEPLOY-A-RUNBOOK.md to child-only (roots still prewarm; move the
  root-limitation note up front - runbook currently overstates coverage).
- Distinguish an ATTACHED/resumed depth>0 child from a passive one so an attached child still eager-starts
  (today it loses the eager start); OR document the first-tool latency for resumed children explicitly.
- Add a real hydration/provisioner integration test: no kernel start on passive child hydration; exactly one
  start/restore before the first tool cell; root/interactive behavior unchanged.
- DEFER woken-root deferral (needs a daemon attach-vs-wake signal in main.ts/daemon-mode.ts) to Deploy B.

======================================================================
A.1 host + launcher - REWORK (files only; must be correct and GATE the cutover). File: src/cli/daemon-launch.ts + deploy/deploy-a/* + DEPLOY-A-RUNBOOK.md
======================================================================
R5 (must-fix): restart-safe containment. Fixed --unit=prime-agent-daemon collides on rapid-restart AND when
  the update coordinator (itself inside the scope) restarts the successor (reproduced "Unit X.scope already
  loaded", exit 1, stderr discarded, no fallback). FIX: a fixed capped PARENT slice `prime-agent.slice`
  (MemoryMax + MemorySwapMax + memory.oom.group set ONCE on the slice) + an auto-named per-instance
  `--scope` under `--slice=prime-agent.slice` (overlapping old/new scopes share the one slice cap, so
  adopted workers in old scopes still count). Add a real fallback when systemd-run EXITS NON-ZERO (not only
  when absent): X_OK check, capture + log its stderr, and on a scoped child that exits before the socket
  appears retry UNSCOPED once with a loud warning; a containment failure must BLOCK the host cutover gate.
  (Confirmed: detached workers/kernels/uv + in-process relaunch + worker replacement inherit the cgroup when
  the first launch is scoped, so those need no separate wrap; daemon-command.ts:696 and explicit --mode
  daemon do NOT - note them.)
R6 (must-fix artifacts + runbook):
- earlyoom.conf: remove the inner single quotes (the host unit runs `sh -c '... $EARLYOOM_ARGS'` so quotes
  stay literal and the regexes match nothing); install path is /etc/default/earlyoom (not /etc/sysconfig);
  fix the -p comment (-p = nice/oom_score_adj for earlyoom itself); raise -M above freeze-day MemAvailable
  (freeze was ~4.6 GiB/7.69% with 0 free swap; -M 4000000=3.81 GiB never trips, == the shipped -m 6); with
  both-conditions AND and MemorySwapMax small, earlyoom is a host backup only - say so; --prefer must target
  `python` (kernels), NOT prime-agent (that regex matches the SUPERVISOR, often the largest process ->
  killing it triggers the adoption storm). Treat MemoryMax cgroup as the PRIMARY guard.
- PRIME_AGENT_RUNTIME_SOURCE (deploy/deploy-a/prime-agent-daemon.env:37 + runbook:48) points at a
  NONEXISTENT path -> as the sole candidate every kernel boot fails clean = NO kernels. Use
  /mnt/devvm/custom/prime/prime-agent-runtime OR packages/coding-agent/dist/prime-agent-runtime. Document
  that PRIME_AGENT_DAEMON_SCOPE + caps + venv/runtime env are read by the LAUNCHING shell (not a unit
  EnvironmentFile) and must be consistent in EVERY launching shell (collectDaemonLaunchEnv forwards the
  client env and spreads it over the supervisor env, so a stray value redirects a worker's venv family).
- runbook: MemoryHigh=50G is set in TWO drop-ins (system.control 50-MemoryHigh.conf AND
  user-400.slice.d/50-memory-soft-cap.conf) - remove BOTH (rm + daemon-reload + set-property, root) and only
  AFTER the scoped daemon is started and cgroup containment of supervisor+workers+kernels is VERIFIED; note
  that while 50G is kept the slice throttle still wins; consider a hard MemoryMax on user-400.slice. Real
  rollback = previous BUILD + PRIME_AGENT_KERNEL_VENV pointed at the untouched legacy
  ~/.prime/agent/kernel-venv (the new code never deletes it), NOT a .current edit. Remove the non-public
  "prepare-update-restart" command. Fix telemetry-sampler.sh zero-count JSON (pgrep -c exits 1) + use
  `pgrep -u` + add rotation.
- MemorySwapMax: prefer ~1-2G or 0 (swap thrash IS the freeze); keep MemoryMax=46G as a HIGH start
  (leaves ~14 GiB of 60.4 GiB). Withdraw or fix the .service template (Type=simple + self-relaunch +
  default KillMode=control-group would kill the successor tree -> KillMode=process; MemoryOOMGroup is
  systemd 247+ and ignored on 239; After+WantedBy=default.target is an ordering cycle). All numbers are
  PROVISIONAL pending a measured cutover gate. A crash-loop breaker (Deploy B) is a prerequisite before
  ratcheting caps down.

======================================================================
Definition of done
======================================================================
- R1-R8 + the must-fix A.1 artifacts implemented; A.4/A.5 land items done; each `npm run build` exit 0,
  targeted isolated tests pass (incl the new A.2 same-identity/GC/rollback tests, the A.3 predicate/reclaim
  tests, the A.4 early-return test, the A.5 hydration test, and the previously-failing B7 callers).
- No prod mutation, no shared-venv rebuild, no live restart. Branch left for re-review (F1 rewrite gets a
  focused re-review before any cutover).
- Deploy B backlog (do NOT do here): generation-agnostic owner scan; root attach-vs-wake signal; oom_score_adj
  shaping (supervisor low, kernels raised); crash-loop breaker; steady-state kernel eviction/termination.
