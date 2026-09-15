# deploy/deploy-a

Host + launcher config artifacts for DEPLOY A. NONE of these are applied by the
`fix/deploy-a-freeze-remediation` branch; they are produced as files for a human,
health-gated cutover. Follow ../../DEPLOY-A-RUNBOOK.md (repo root DEPLOY-A-RUNBOOK.md).

Files:
- prime-agent-daemon.env: recommended daemon environment (launcher scope caps, kernel-boot
  cap, worker self-exit knob, per-checkout venv, runtime source). Source from the launcher
  wrapper or a unit EnvironmentFile. Fix paths for prod first.
- prime-agent-daemon.service: a systemd --user unit TEMPLATE with MemoryMax + MemorySwapMax
  + Delegate, as an alternative to the launcher's transient `systemd-run --user --scope`
  (PRIME_AGENT_DAEMON_SCOPE=1 in cli/daemon-launch.ts). Not installed live.
- earlyoom.conf: retuned earlyoom args - absolute -M/-S for the 64G swap, comm-accurate
  regexes for `prime-agent` (daemon) and `python` (kernels), and -g. The shipped
  --prefer node / --avoid python3 match NOTHING of ours (verified), so earlyoom is inert
  today.
- telemetry-sampler.sh: a lightweight host sampler writing one JSON line per interval with
  the daemon scope's memory.current / memory.swap.current, system MemAvailable / SwapFree,
  and prime-agent + python process counts. Use it to measure the legit steady state before
  ratcheting MemoryMax down.

The launcher scope itself is code (A.1) in packages/coding-agent/src/cli/daemon-launch.ts
(buildDaemonScopeInvocation), opt-in via PRIME_AGENT_DAEMON_SCOPE=1, reversible, and falls
back to the unscoped launch with a logged warning if systemd-run is absent.
