# DEPLOY A - second fix pass (branch fix/deploy-a-freeze-remediation, base 9f387439e)

Source: 3 independent re-reviews of the first fix pass (fable-5.1 + gpt-6-astra + grok-4.6). Consensus:
the design is right and the A.2 linchpin is genuinely fixed (the 3 proven bugs are closed, re-verified with
repros on the built dist). These are small/local CORRECTIONS to the rework plus one install-path fix. Full
detail: /home/ndsadmin/prime-v094-freeze-review/deploy-a-review-progress.json (re_review section).

RULES (unchanged): prime-next only; NEVER touch prod or the shared venv; isolate any kernel/daemon test with
PRIME_AGENT_KERNEL_VENV=/tmp/... + TMPDIR; commit --no-verify (biome broken, glibc 2.28); validate each with
`cd packages/coding-agent && npm run build` (exit 0) + targeted isolated vitest; one commit per area; no em/en
dashes (manual scan). Do NOT merge; leave for a final targeted re-check.

======================================================================
MUST-FIX (before land)
======================================================================
M1 [A.2, HIGHEST - all 3 reviewers, reproduced] post-publication deletion + boot loop.
   bootstrap.ts:1338-1356: publishGeneration + clearBootstrapFailure are INSIDE the try whose catch does
   rm(buildDir). If clearBootstrapFailure (marker rm) throws non-ENOENT (EPERM/EROFS/EIO/EISDIR), the
   just-PUBLISHED generation is deleted and the pointer is left dangling; the next boot rebuilds, publishes,
   fails cleanup, and rm's again = a build-and-delete LOOP with no backoff. FIX: treat publication as
   irreversible - move publishGeneration + clearBootstrapFailure AFTER the rm-guarded try (or set
   published=true and skip the rm when published); make clearBootstrapFailure best-effort (.catch - a stale
   marker is harmless, it is only consulted before a full rebuild and expires); never rm a candidate that
   current/previous can name, including an atomic-write error reported after rename. TEST: publish succeeds,
   marker rm throws -> the published dir survives and the pointer stays valid.

M2 [A.5, HIGH regression - astra verified + factory-reproduced; parent-verified] restore passive-child deferral.
   Dropping `&& _rlmDepth === 0` did NOT distinguish attached vs passive: main.ts:769-776
   (createDefaultRuntimeFactory, the production factory for EVERY daemon-hosted session) sets
   prewarmIpythonKernel:true unconditionally and OVERWRITES a false passed via sessionOptions; both fresh
   children (daemon-mode.ts:3047-3054) and passive hydration (rehydrateCompletedRlmSubagentOnce
   :3494-3502) use it, so ALL daemon children now eager-prewarm (the memory win is lost). FIX for Deploy A:
   RESTORE the `&& this._rlmDepth === 0` guard in agent-session.ts _shouldEagerPrewarmKernel (the gate
   ignores prewarm for depth>0 regardless of the factory); document that attached depth>0 children pay
   first-tool latency in Deploy A; update the main.ts:773-776 comment; defer the true attach-vs-passive
   signal to Deploy B. TEST: a real factory/hydration test - a depth>0 factory session starts NO kernel until
   the first tool cell, then exactly one start/restore; a root/interactive session prewarms once. (The
   existing direct-provisioner test cannot catch this.)

M3 [A.3 - grok] boot-broadcast race. reclaimStaleDeadWorkers' broadcastHeartbeatsChanged at boot can start a
   due-wake BEFORE markReady (the broadcast does not await; wakeDueScheduledSessions is not gated on
   startupComplete; the current tests miss it because makeSupervisor sets shuttingDown:true). FIX: only
   broadcast/recompute from reclaim when startupComplete && !shuttingDown && updateRestartPhase === undefined
   (boot already rearms one line later).

M4 [A.3 - astra, reproduced] cleanup-failure retryability trap. reclaimStaleWorkerRegistration sets
   worker.intentionalStop=true at :3129 before awaiting cleanup at :3130; on a transient cleanup rejection the
   new wrapper logs a deferred reclaim but leaves intentionalStop set, so isReclaimableDeadDescriptor (:5219)
   then excludes the worker as stopping forever. FIX: retain descriptors/journals on failure AND preserve
   retryability - roll back the temporary stop intent on failure, or set it only after cleanup succeeds, or a
   resumable single-flight finalizer. TEST: cleanup rejects then succeeds -> the worker is reclaimed on a later
   sweep. Also add the contract's real sole-root ready -> disconnect -> failed -> due-wake integration test.

M5 [A.1 - astra + grok, grok #1 blocker] retry only on scoped-child exit, never on a live-child timeout.
   daemon-launch.ts:474 retries UNSCOPED after ANY started=false, including attemptDaemonLaunch returning
   false on a 30s timeout while the scoped child is still alive (:566-567, :579-595) - which spawns a SECOND
   daemon (the unscoped one can win the lease => containment lost); boot reclaim being awaited can push hello
   past 30s and trip this. FIX: attemptDaemonLaunch returns childExited/spawnError; retry UNSCOPED only on a
   confirmed early exit / spawn failure; a live timed-out launcher stays fail-closed (keep waiting or throw,
   never a second spawn). TESTS: nonzero-exit fallback fires; exactly one retry; alive-timeout does NOT
   second-launch.

M6 [A.1 - astra + grok] gate on the effective cap, not just membership. The runbook (DEPLOY-A-RUNBOOK.md
   :103-117, :145-149) installs/sets and checks cgroup membership + memory.current only; an implicitly created
   or misconfigured UNCAPPED prime-agent.slice of the same name would pass. FIX (runbook + a verify helper):
   assert numeric memory.max and memory.swap.max (reject max/infinity, missing/unreadable controllers,
   unexpected values) AND memory.oom.group=0 AND effective ControlGroup, BEFORE removing MemoryHigh and again
   after restart; gate on EVERY fallback outcome (not only the "retrying UNSCOPED" text - the missing/non-exec
   warning differs).

M7 [A.1 - astra] stderr capture must not become the daemon's long-lived unlinked FD. attemptDaemonLaunch
   passes a fixed per-socket .scope-launch file FD as the daemon descendant stderr (:509-525) and unlinks it
   on success (:554-557/:584); the daemon keeps FD 2 to the deleted inode while DaemonSupervisor.log still
   console.error()s (:915-918) = an invisible unrotated growing log; concurrent starts clobber it. FIX:
   capture only systemd-run's OWN short-lived stderr with a unique bounded per-attempt file; after scope
   success redirect the daemon's stderr to the normal rotated log; never leave the daemon on an unlinked
   growable FD.

M8 [install.sh / entrypoint - fable recommendation, adopted] the hard "require PRIME_AGENT_KERNEL_VENV" broke
   the native installer (install.sh:2185 calls --prime-agent-bootstrap without the env -> the consented
   install-time Python prep now deterministically fails and continues; the npm postinstall path uses
   ensureKernelPython directly so the two install paths diverge; scripts/benchmarks/worker.py:331 still fails).
   Since GC is now opt-in, a default-base prebuild is NON-destructive (verified). FIX: the public
   --prime-agent-bootstrap should WARN and prebuild the DEFAULT family when the env is unset (as
   bootstrap-cli.ts does today), and gate strictness behind PRIME_AGENT_KERNEL_VENV_REQUIRED=1 which the
   runbook sets for the deploy prebuild. TEST: a native-installer/public-flag run with NO caller venv variable
   prebuilds the default family and exits 0.

======================================================================
SHOULD (fold in; cheap and reduce risk)
======================================================================
- A.2 N2: honor PRIME_AGENT_KERNEL_VENV_FORCE_REBUILD only inside runKernelPrebuild (one-shot), or document it
  as prebuild-only and never to be exported in a launching shell (collectDaemonLaunchEnv forwards the client
  env -> a rebuild storm otherwise).
- A.2 N3: take the bootstrap lock inside gcOldGenerations; runbook: run opt-in GC only after a full daemon
  restart when no old-generation kernels are alive.
- A.2 N4: in findReusableGeneration, syncPythonSkills BEFORE publishGeneration (avoid a briefly-unsynced gen).
- A.2 N5: remove the now-dead generationVenvDir().
- A.2 tests: add public-flag (named/missing/conflicting-python), prebuild, and gcOldGenerations family-regex
  unit tests.
- A.2 docs: ipython.ts:45 point to FORCE_REBUILD/new-generation repair (not restart); fix the stale GC comments
  (:107-109, :1150); docs/rlm-runtime.md:79 + docs/skills.md:168 describe the pointer-named generation, and
  note that legacy/pre-format venvs do a full ~320MB build on first use (so the cutover prebuild is essential).
- A.1: earlyoom --prefer must also match python3 (use (^|/)python[0-9.]*$); rollback must restore a matching
  PRIME_AGENT_RUNTIME_SOURCE (not just build+legacy venv); the telemetry sampler must resolve THIS user's
  cgroup via its ControlGroup (not the first same-named slice); document that daemon-command.ts:696 runStart
  and explicit --mode daemon bypass the scope wrapper.
- Runbook: add the F8 one-time first-boot skill-sync note (trigger with a single session before load).

======================================================================
Definition of done
======================================================================
- M1-M8 implemented; each `npm run build` exit 0; new/updated targeted tests pass isolated (esp the M1 marker-rm
  regression, the M2 factory/hydration test, the M4 cleanup-retry test, the M5 launcher retry tests, the M8
  no-venv installer test). No prod mutation, no shared-venv rebuild, no live restart. Branch left for a final
  targeted re-check. Deploy B backlog unchanged (owner-scan, root attach-vs-wake, oom_score_adj, crash-loop
  breaker, live-reference GC/eviction).
