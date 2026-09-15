#!/bin/sh
# Prime Agent daemon telemetry sampler (Deploy A). NOT installed/run by the fix branch.
# A lightweight host-side sampler: it writes one JSON line per interval with the daemon
# scope's memory.current / memory.swap.current, system MemAvailable / SwapFree, and the
# worker + kernel process counts (by comm). Run it under the SAME scope/unit as the daemon
# (or point SCOPE_CGROUP at the daemon's cgroup) so memory.current reflects the daemon tree.
#
# In-process event-loop-lag and collectPassiveScheduledJobs/flushRoster durations are a
# Deploy B addition inside the supervisor; this script covers the host-visible signals now.
#
# Usage: SCOPE_CGROUP=/sys/fs/cgroup/.../prime-agent-daemon.scope INTERVAL=30 \
#        OUT=~/.prime/agent/telemetry.jsonl telemetry-sampler.sh
set -eu
INTERVAL="${INTERVAL:-30}"
OUT="${OUT:-$HOME/.prime/agent/telemetry.jsonl}"
SCOPE_CGROUP="${SCOPE_CGROUP:-}"

read_first() { [ -r "$1" ] && head -n1 "$1" 2>/dev/null || echo ""; }
meminfo_kib() { awk -v k="$1" '$1==k":"{print $2}' /proc/meminfo 2>/dev/null || echo ""; }

while :; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mem_current=""; swap_current=""
  if [ -n "$SCOPE_CGROUP" ]; then
    mem_current=$(read_first "$SCOPE_CGROUP/memory.current")
    swap_current=$(read_first "$SCOPE_CGROUP/memory.swap.current")
  fi
  mem_avail_kib=$(meminfo_kib MemAvailable)
  swap_free_kib=$(meminfo_kib SwapFree)
  workers=$(pgrep -c -x prime-agent 2>/dev/null || echo 0)
  kernels=$(pgrep -c -x python 2>/dev/null || echo 0)
  printf '{"ts":"%s","scope_memory_current":"%s","scope_swap_current":"%s","mem_available_kib":"%s","swap_free_kib":"%s","prime_agent_procs":%s,"python_procs":%s}\n' \
    "$ts" "$mem_current" "$swap_current" "$mem_avail_kib" "$swap_free_kib" "$workers" "$kernels" >> "$OUT"
  sleep "$INTERVAL"
done
