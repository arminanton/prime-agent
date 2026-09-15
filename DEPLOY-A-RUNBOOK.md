# DEPLOY A - health-gated cutover runbook

This branch (`fix/deploy-a-freeze-remediation`) is BUILD-ONLY. Nothing here restarts the
prod daemon, rebuilds the prod venv, or applies host config live. This runbook is the
human, health-gated cutover to be run by hand LATER. Do it on the prod host
(/mnt/devvm/custom/prime is the SEPARATE prod worktree; this branch lives in
/mnt/devvm/custom/prime-next).

Root cause recap (verified 2026-09-15): the v0.9.1->v0.9.4 upgrade forced a kernel-venv
rebuild storm and deploy churn; the hard freeze was host memory/swap exhaustion under the
user-400.slice MemoryHigh=50G SOFT throttle (MemoryMax=infinity) with earlyoom never
firing. The daemon + kernels ran in the SSH login scope (session-3.scope).

What Deploy A changes (build phase, this branch):
- A.2 (bootstrap.ts, bootstrap-cli.ts, cli/runtime-bootstrap.ts): non-destructive generation
  venv. Every build lands in a UNIQUE sibling `<base>-<hash>-<nonce>`, validated, then
  published via a `<base>.current` pointer; no directory the pointer names is ever removed. A
  same-identity readiness-probe failure (the freeze-day path) fails clean and leaves the live
  venv intact; a rollback re-publishes an existing generation instead of rebuilding; in-band GC
  is disabled. Ported PR #2203 (fail clean on missing runtime source) as the base.
- A.3 (daemon-supervisor.ts): a confirmed-dead descriptor no longer masks scheduled wakes but a
  failed-but-ALIVE worker stays covered (no head-of-line-blocking recovery ladder); reclaim runs
  the settling path (orphan-kernel reaping) before deleting a descriptor at boot and before a
  fenced update restart (so the 7 stale descriptors stop forcing cold restarts).
- A.4 (daemon-mode.ts): the supervisor-replacement probe needs 3 consecutive failures with a 3s
  timeout and a live-owner check, so a transient probe never spawns a second daemon.
- A.5 (agent-session.ts): a passive daemon-hydrated CHILD session defers its kernel start to
  first ipython use instead of eagerly loading GB of kernel state on every hydration. Roots
  still prewarm, and an interactive attached/resumed child also eager-starts; deferring a woken
  ROOT'S prewarm is Deploy B.
- A.1 (cli/daemon-launch.ts + these deploy/ artifacts): an opt-in launcher cgroup scope under a
  capped parent slice, plus the host config templates below. NONE of the host config is applied
  by this branch.

## 0. Preconditions and health gate

Do NOT start unless ALL hold:
- Host is healthy now: `free -g` shows swap use well below the earlyoom thresholds, no
  order:N page-allocation failures in `journalctl -k -n 200`.
- The new build passes: from packages/coding-agent, `npm run build` exits 0 and the
  targeted vitest suites pass.
- You have a matching-version launcher for the CURRENTLY running daemon (needed for step 2).
- You have a rollback path noted (previous build dir + the untouched legacy venv, section R).

## 1. Prebuild the per-checkout kernel venv (no daemon involved)

Prebuild the venv the new daemon will use, single-threaded, BEFORE any restart, so the
cutover never triggers an in-band rebuild storm. A.2 builds a unique generation dir
`<base>-<hash>-<nonce>` and publishes a `<base>.current` pointer; it never touches any other
venv family. `--prime-agent-bootstrap` now REQUIRES PRIME_AGENT_KERNEL_VENV and rejects a
conflicting PRIME_AGENT_KERNEL_PYTHON, so a prebuild only ever touches its named family.

```bash
cd /path/to/new/checkout/packages/coding-agent
export PRIME_AGENT_KERNEL_VENV=/home/ndsadmin/.prime/agent/kernel-venv-prod
# This checkout's runtime source (repo-root prime-agent-runtime, or its built dist copy). The
# path MUST resolve; a missing source fails the bootstrap clean (no kernels).
export PRIME_AGENT_RUNTIME_SOURCE=/mnt/devvm/custom/prime/prime-agent-runtime
# Deploy-time prebuild via the REAL public flag: prints the runtime identity + resolved venv +
# python, exits non-zero on failure (a deploy blocker), and only touches the
# PRIME_AGENT_KERNEL_VENV family. Set PRIME_AGENT_KERNEL_VENV_REQUIRED=1 so the public flag is
# strict (it fails instead of falling back to the default family when PRIME_AGENT_KERNEL_VENV is
# unset).
#
# F8 (one-time first-boot skill sync): the prebuild builds the base generation but installs NO
# Python skills. The first real session syncs skills IN PLACE into the live generation (a fast
# uv-pip step, no rebuild). Trigger it once with a single throwaway session BEFORE putting the
# daemon under load, so the first user turn does not pay the skill-sync latency:
#   prime-agent -p "noop" >/dev/null 2>&1 || true
node dist/cli.js --prime-agent-bootstrap
```

Verify it printed all three lines and exited 0:
`runtime identity: sha256:...`, `kernel venv: <base>-<hash>-<nonce>`, and
`kernel python: <base>-<hash>-<nonce>/bin/python`. Confirm `<base>.current` names that
generation. If it fails, STOP: the daemon must not be restarted onto a missing venv.

## 2. Clear the stale "failed and disconnected" descriptors

These exist on the running (pre-A.3) daemon and block the update-restart fence. A.3 makes them
self-clear going forward (reclaim at boot and before the fence), but the LIVE pre-A.3 daemon
still needs them cleared once by hand. Use the recover-failed-daemon-worker procedure per stuck
session (identity-verified, supervisor-controlled, non-destructive). For each stuck workerId's
session file:

```bash
# kill -0 <pid> must FAIL first (confirm the worker process is gone).
<matching-launcher> --dist --daemon-socket <socket> --cwd <original-cwd> \
  --resume /absolute/path/to/sessions/<id>.jsonl --print < /dev/null
```

The create reclaims the dead registration before any prompt. Then run your NORMAL update path
(the public update/restart flow, which internally drains and fences) as a dry run or preflight
and confirm it no longer reports "failed and disconnected". Do NOT rely on any non-public
prepare command; A.3's reclaim is what clears these going forward.

## 3. Stage host config (review, then apply deliberately)

Files are in deploy/deploy-a/. Review each, then apply under this health gate. Reversible.

- Env PLACEMENT: install the values from deploy/deploy-a/prime-agent-daemon.env into the LOGIN
  environment of EVERY shell that may launch the daemon (for example ~/.bash_profile, or the
  launcher wrapper) - they are read by the launching CLI process, NOT by a unit EnvironmentFile.
  If only some shells set PRIME_AGENT_DAEMON_SCOPE, a shell-driven ensureDaemonRunning spawn is
  unscoped. Keep PRIME_AGENT_KERNEL_VENV and PRIME_AGENT_RUNTIME_SOURCE identical in every
  launching shell (or unset everywhere): collectDaemonLaunchEnv forwards the client env over the
  supervisor env, so a stray value redirects a worker's venv family. Fix the paths for prod. Key
  values: PRIME_AGENT_DAEMON_SCOPE=1, PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS=2,
  PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS=86400000, per-checkout
  PRIME_AGENT_KERNEL_VENV, and a resolvable PRIME_AGENT_RUNTIME_SOURCE.
- Slice caps: install deploy/deploy-a/prime-agent.slice to ~/.config/systemd/user/ and
  `systemctl --user daemon-reload`, OR set them at runtime:
  `systemctl --user set-property prime-agent.slice MemoryAccounting=yes MemoryMax=46G MemorySwapMax=1G`.
  The caps live on the SLICE, not each scope, so overlapping old and new scopes during a restart
  share ONE cap. Start MemoryMax HIGH (46G, leaves ~14G) and ratchet down only after a week of
  telemetry AND after Deploy B lands the crash-loop breaker. Keep MemorySwapMax tiny (1G or 0):
  swap thrash IS the freeze. Do NOT install prime-agent-daemon.service (WITHDRAWN; it does not
  fit the self-relaunch update-restart model).
- Start the scoped daemon and VERIFY containment + the EFFECTIVE CAP BEFORE touching the soft cap:
  with PRIME_AGENT_DAEMON_SCOPE=1 set, start the daemon through the AUTO-LAUNCH path (run a normal
  client command such as `prime-agent list`, which triggers ensureDaemonRunning). Do NOT start it
  with `prime-agent start` or an explicit `prime-agent --mode daemon`: those spawn the daemon
  directly (daemon-command.ts runStart at :696) and BYPASS the systemd-run scope wrapper, so the
  daemon lands unscoped. Then run the verifier:
  `EXPECT_MEMORY_MAX_BYTES=<slice MemoryMax in bytes> EXPECT_MEMORY_SWAP_MAX_BYTES=<slice MemorySwapMax in bytes> deploy/deploy-a/verify-containment.sh`.
  It resolves THIS user's prime-agent.slice via its ControlGroup and asserts: the memory controller
  is present, memory.max and memory.swap.max are BOUNDED integers (rejecting "max"/infinity/missing
  and any value that does not match the expected bytes), memory.oom.group=0, every prime-agent /
  python process is under the slice, and the client-errors log has NO scope-fallback marker
  ("cgroup containment NOT applied", which BOTH fallback outcomes now carry - systemd-run
  missing/non-exec AND the confirmed-early-exit UNSCOPED retry). Membership + memory.current alone
  is NOT enough: an implicitly created UNCAPPED prime-agent.slice of the same name would pass a
  membership check but fail the cap assertion. `systemd-cgls --user` remains a useful visual cross
  check (every prime-agent/python pid inside a `*.scope` under prime-agent.slice, NOT
  session-3.scope). Any verifier failure BLOCKS the rest of the cutover.
- ONLY after containment is verified, remove the user-400.slice MemoryHigh=50G SOFT throttle -
  it IS the freeze, and while it is kept it still throttles the whole user slice (the daemon
  scope sits under it). It is set in TWO drop-ins on this host
  (system.control/50-MemoryHigh.conf AND user-400.slice.d/50-memory-soft-cap.conf): remove BOTH
  as root, then reload and clear the live property:
  `rm the two drop-in files`, then `systemctl daemon-reload`, then
  `systemctl set-property user-400.slice MemoryHigh=infinity`. Consider a HARD MemoryMax on
  user-400.slice as an outer host bound once the per-daemon cap is trusted.
- earlyoom (HOST BACKUP only; the cgroup MemoryMax is PRIMARY): apply
  deploy/deploy-a/earlyoom.conf to /etc/default/earlyoom (this host's earlyoom.service uses
  EnvironmentFile=/etc/default/earlyoom), then restart earlyoom. It uses absolute -M/-S in KiB
  (with -M above freeze-day MemAvailable), NO inner quotes, and --prefer `python[0-9.]*` (matches
  python/python3/python3.11 comms; a kernel is the right first victim; the `prime-agent`
  supervisor is avoided so killing it does not orphan every worker). Numbers are PROVISIONAL.
- Telemetry: start deploy/deploy-a/telemetry-sampler.sh (it resolves the prime-agent.slice cgroup
  via THIS user's ControlGroup, not the first same-named dir) so you can measure memory.current /
  memory.swap.current before ratcheting MemoryMax down.

## 4. Update-restart onto the new build

With the venv prebuilt (1), descriptors cleared (2), host config staged and containment verified
(3), do the normal update-restart to the new build. Because the venv identity already matches the
prebuilt generation, no in-band rebuild happens. The successor re-enters the same
prime-agent.slice cap (the auto-named scope avoids a unit-name collision on restart).

## 5. Post-cutover verification (health gate)

- Containment + effective cap hold: re-run
  `EXPECT_MEMORY_MAX_BYTES=... EXPECT_MEMORY_SWAP_MAX_BYTES=... deploy/deploy-a/verify-containment.sh`
  after the restart (it must exit 0 again: bounded memory.max/memory.swap.max, memory.oom.group=0,
  all prime-agent/python under prime-agent.slice, no scope-fallback marker in the client-errors
  log). `systemd-cgls --user` shows the supervisor + workers + kernels under a `*.scope` in
  prime-agent.slice, NOT session-3.scope.
- `prime-agent list` shows the expected sessions; the main conversation resumes.
- Telemetry lines show slice memory.current well under MemoryMax and swap use flat.
- A test scheduled wake fires (A.3): a session with a due job wakes without a live worker.
- No new "failed and disconnected" descriptors accumulate.

## R. Rollback

- Real rollback = the PREVIOUS BUILD plus PRIME_AGENT_KERNEL_VENV pointed at the untouched legacy
  `~/.prime/agent/kernel-venv` (the new code never deletes it) AND a matching
  PRIME_AGENT_RUNTIME_SOURCE. Restart the daemon from the previous build directory (its launcher)
  with PRIME_AGENT_KERNEL_VENV set to the legacy base and PRIME_AGENT_RUNTIME_SOURCE restored to
  the value that previous build used (or unset so it uses that build's shipped runtime copy):
  the generation identity is hashed from the runtime source, so leaving RUNTIME_SOURCE pointed at
  the new checkout would make the legacy venv non-current and force a full rebuild. Keep both env
  values identical across EVERY launching shell (collectDaemonLaunchEnv forwards the client env).
  Sessions persist on disk and reload. Do NOT roll back by editing `<base>.current`: a venv-only
  pointer edit only makes sense together with a matching build rollback, and a pre-Deploy-A build
  does not understand the pointer.
- A within-Deploy-A venv rollback (same new build) can re-publish the previous generation: A.2
  kept it as `previous` in `<base>.current` and never removed it, so pointing the identity back
  re-publishes it with zero uv. Prefer the build rollback above for a true revert.
- Host config: set PRIME_AGENT_DAEMON_SCOPE=0 (or unset) in the launching shells to drop the
  scope wrapper; restore the two user-400.slice MemoryHigh drop-ins and
  `systemctl daemon-reload`; revert /etc/default/earlyoom and restart earlyoom.

## Deploy B follow-ups referenced here

- Supervisor crash-loop breaker: N recoveries of the same worker in M minutes -> park +
  alert (needed before ratcheting MemoryMax down, so an OOM kill of the root worker does not
  become a relaunch/re-OOM loop).
- Completion-based worker termination (lets PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS
  return to a small value).
- A daemon-supplied attach-vs-wake signal so a passively woken ROOT (not just children) can
  also defer its kernel prewarm (A.5 currently defers passive children only).
- A generation-agnostic current-owner lookup by socketPath for the supervisor-replacement probe
  (A.4 guards only workers that have already seen a supervisor claim).
- In-process telemetry: event-loop lag and collectPassiveScheduledJobs/flushRoster durations
  inside the supervisor (the host sampler here covers memory + process counts only).
- Family-exact operator/prebuild-time generation GC with a live-reference check (A.2 disables
  in-band GC; superseded generations accumulate until then).
