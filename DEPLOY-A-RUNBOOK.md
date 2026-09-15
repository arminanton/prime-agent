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
- A.2 (bootstrap.ts, bootstrap-cli.ts): non-destructive generation venv + backoff so an
  identity-change rebuild never deletes the working venv and a failing rebuild never
  cascades. Ported PR #2203 (fail clean on missing runtime source) as the base.
- A.3 (daemon-supervisor.ts): a failed/dead descriptor no longer masks scheduled wakes,
  and confirmed-dead unowned descriptors are reclaimed at boot and before a fenced update
  restart (so the 7 stale descriptors stop forcing cold restarts).
- A.4 (daemon-mode.ts): the supervisor-replacement probe needs 3 consecutive failures with
  a 3s timeout and a live-owner check, so a transient probe never spawns a second daemon.
- A.5 (agent-session.ts): a passive daemon-hydrated session defers its kernel start to
  first ipython use instead of eagerly loading GB of kernel state on every hydration.
- A.1 (cli/daemon-launch.ts + these deploy/ artifacts): an opt-in launcher cgroup scope,
  plus the host config templates below. NONE of the host config is applied by this branch.

## 0. Preconditions and health gate

Do NOT start unless ALL hold:
- Host is healthy now: `free -g` shows swap use well below the earlyoom thresholds, no
  order:N page-allocation failures in `journalctl -k -n 200`.
- The new build passes: from packages/coding-agent, `npm run build` exits 0 and the
  targeted vitest suites pass.
- You have a matching-version launcher for the CURRENTLY running daemon (needed for step 2).
- You have a rollback path noted (previous build dir + previous venv generation, section R).

## 1. Prebuild the per-checkout kernel venv (no daemon involved)

Prebuild the venv the new daemon will use, single-threaded, BEFORE any restart, so the
cutover never triggers an in-band rebuild storm. A.2 builds a versioned generation dir
`<base>-<identityHash>` and publishes a `<base>.current` pointer; it never touches any
other venv.

```bash
cd /path/to/new/checkout/packages/coding-agent
export PRIME_AGENT_KERNEL_VENV=/home/ndsadmin/.prime/agent/kernel-venv-prod
export PRIME_AGENT_RUNTIME_SOURCE="$PWD/prime-agent-runtime"   # this checkout's runtime source
# Deploy-time prebuild: prints the runtime identity + resolved venv + python, exits non-zero
# on failure (a deploy blocker), and only touches the PRIME_AGENT_KERNEL_VENV family.
node dist/cli.js --prime-agent-bootstrap    # or: tsx src/core/kernel/bootstrap-cli.ts
```

Verify it printed `runtime identity: sha256:...`, `kernel venv: <base>-<hash>`, and
`kernel python: <base>-<hash>/bin/python`, and exited 0. Confirm `<base>.current` names
that generation. If it fails, STOP: the daemon must not be restarted onto a missing venv.

## 2. Clear the 7 stale "failed and disconnected" descriptors

These exist on the running (pre-A.3) daemon and block `prepare_update_restart`. A.3 makes
them self-clear going forward, but the LIVE daemon still needs them cleared once by hand.
Use the recover-failed-daemon-worker procedure per stuck session (identity-verified,
supervisor-controlled, non-destructive). For each stuck workerId's session file:

```bash
# kill -0 <pid> must FAIL first (confirm the worker process is gone).
<matching-launcher> --dist --daemon-socket <socket> --cwd <original-cwd> \
  --resume /absolute/path/to/sessions/<id>.jsonl --print < /dev/null
```

The `create` reclaims the dead registration before any prompt. Re-run
`prime-agent daemon prepare-update-restart` (or your update path's dry run) and confirm it
no longer reports "failed and disconnected".

## 3. Stage host config (review, then apply deliberately)

Files are in deploy/deploy-a/. Review each, then apply under this health gate. Reversible.

- Env: install deploy/deploy-a/prime-agent-daemon.env to the launcher/unit EnvironmentFile
  path. Fix the paths for prod. Key values: PRIME_AGENT_DAEMON_SCOPE=1,
  PRIME_AGENT_DAEMON_SCOPE_MEMORY_MAX=46G, PRIME_AGENT_DAEMON_SCOPE_MEMORY_SWAP_MAX=6G,
  PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS=2,
  PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS=86400000, per-checkout
  PRIME_AGENT_KERNEL_VENV, PRIME_AGENT_RUNTIME_SOURCE.
- Scope: the launcher scope is opt-in via PRIME_AGENT_DAEMON_SCOPE=1 (systemd-run --user
  --scope with MemoryMax + MemorySwapMax + Delegate=yes). For a persistent unit instead,
  use deploy/deploy-a/prime-agent-daemon.service. Start MemoryMax HIGH (46G) and ratchet
  down only after a week of telemetry and after Deploy B lands the crash-loop breaker.
- REMOVE or raise the user-400.slice MemoryHigh=50G SOFT throttle (it IS the freeze):
  `systemctl set-property user-400.slice MemoryHigh=infinity` (or drop the drop-in). The
  daemon's own scope now provides the hard bound instead.
- earlyoom: apply deploy/deploy-a/earlyoom.conf (absolute -M/-S for 64G swap, comm-accurate
  regexes for `prime-agent` and `python`, -g). The shipped --prefer node / --avoid python3
  match NOTHING of ours (verified), so earlyoom is currently inert. Restart earlyoom after.
- Telemetry: start deploy/deploy-a/telemetry-sampler.sh pointed at the daemon scope cgroup
  so you can measure memory.current / memory.swap.current before ratcheting MemoryMax down.

## 4. Update-restart onto the new build

With the venv prebuilt (1), descriptors cleared (2), and host config staged (3), do the
normal update-restart to the new build. Because the venv identity already matches the
prebuilt generation, no in-band rebuild happens.

## 5. Post-cutover verification (health gate)

- The daemon and its workers/kernels are in the new scope: `systemctl --user status
  prime-agent-daemon` (unit) or `systemd-cgls` shows them under the scope, NOT session-3.
- `prime-agent list` shows the expected sessions; the main conversation resumes.
- Telemetry lines show scope memory.current well under MemoryMax and swap use flat.
- A test scheduled wake fires (A.3): a session with a due job wakes without a live worker.
- No new "failed and disconnected" descriptors accumulate.

## R. Rollback

- Venv: A.2 keeps the previous generation and records it as `previous` in `<base>.current`.
  To roll back the venv, rewrite `<base>.current` `current` to the previous generation
  basename (or delete the pointer to fall back to the base path), then restart the daemon.
  Old generations are retained (GC only removes ones older than the current + previous).
- Build: restart the daemon from the previous build directory (its launcher), which repoints
  to its own PRIME_AGENT_KERNEL_VENV generation. Sessions persist on disk and reload.
- Host config: set PRIME_AGENT_DAEMON_SCOPE=0 (or unset) to drop the scope wrapper; restore
  the user-400.slice MemoryHigh drop-in; revert the earlyoom drop-in and restart earlyoom.

## Deploy B follow-ups referenced here

- Supervisor crash-loop breaker: N recoveries of the same worker in M minutes -> park +
  alert (needed before ratcheting MemoryMax down, so an OOM kill of the root worker does not
  become a relaunch/re-OOM loop).
- Completion-based worker termination (lets PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS
  return to a small value).
- A daemon-supplied attach-vs-wake signal so a passively woken ROOT (not just children) can
  also defer its kernel prewarm (A.5 currently defers passive children only).
- In-process telemetry: event-loop lag and collectPassiveScheduledJobs/flushRoster durations
  inside the supervisor (the host sampler here covers memory + process counts only).
