# deploy/deploy-a

Host + launcher config artifacts for DEPLOY A. NONE of these are applied by the
`fix/deploy-a-freeze-remediation` branch; they are produced as files for a human,
health-gated cutover. Follow ../../DEPLOY-A-RUNBOOK.md (repo root DEPLOY-A-RUNBOOK.md).

Files:
- prime-agent-daemon.env: recommended daemon environment (launcher scope opt-in, kernel-boot
  cap, worker self-exit knob, per-checkout venv, runtime source). These are read by the
  LAUNCHING shell, not a unit EnvironmentFile, so put them in the login environment of EVERY
  shell that may start the daemon; a stray PRIME_AGENT_KERNEL_VENV / PRIME_AGENT_RUNTIME_SOURCE
  in one client shell redirects that worker's venv family (collectDaemonLaunchEnv forwards the
  client env over the supervisor env). Fix paths for prod first.
- prime-agent.slice: the fixed capped PARENT slice the launcher scope runs under. The
  MemoryMax / MemorySwapMax caps live HERE (set once), so overlapping old and new daemon
  scopes during a restart share ONE cap. Install it (or use the equivalent
  `systemctl --user set-property prime-agent.slice ...`).
- prime-agent-daemon.service: WITHDRAWN. A persistent Type=simple unit does not fit the
  daemon's self-relaunch update-restart model (the old supervisor exits, so the unit goes
  inactive and control-group kill would take the successor); the file documents why and points
  to the slice + launcher scope. Do NOT install it.
- earlyoom.conf: retuned earlyoom args for /etc/default/earlyoom - absolute -M/-S in KiB (with
  -M ABOVE freeze-day MemAvailable), NO inner quotes (the host wrapper passed the shipped quotes
  literally so the regexes matched nothing), --prefer targeting `python` (kernels) NOT
  `prime-agent` (the supervisor), and -g. earlyoom is a HOST BACKUP only; the per-daemon cgroup
  MemoryMax on prime-agent.slice is the PRIMARY guard.
- telemetry-sampler.sh: a host sampler writing one JSON line per interval with the daemon SLICE
  cgroup memory.current / memory.swap.current (auto-discovered), system MemAvailable / SwapFree,
  and this user's prime-agent + python process counts (pgrep -u, zero-safe), with single-
  generation output rotation. Measure the legit steady state before ratcheting MemoryMax down.

The launcher scope itself is code (A.1) in packages/coding-agent/src/cli/daemon-launch.ts
(buildDaemonScopeInvocation): opt-in via PRIME_AGENT_DAEMON_SCOPE=1, an auto-named transient
scope under prime-agent.slice, reversible, and falls back to an UNSCOPED launch with a logged
warning if systemd-run is missing/not executable or a scoped spawn exits before the socket
appears. A fallback means containment was NOT applied, so the cutover gate must verify cgroup
membership before removing the user-400.slice soft cap.
