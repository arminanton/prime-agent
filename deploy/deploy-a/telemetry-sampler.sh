#!/bin/sh
# Prime Agent daemon telemetry sampler (Deploy A). NOT installed/run by the fix branch.
# One JSON line per interval: the daemon SLICE cgroup memory.current / memory.swap.current,
# system MemAvailable / SwapFree, and this user's worker + kernel process counts (by comm).
# Use it to measure the legit steady state before ratcheting the slice MemoryMax down.
#
# In-process event-loop-lag and collectPassiveScheduledJobs/flushRoster durations are a Deploy B
# addition inside the supervisor; this script covers the host-visible signals now.
#
# The daemon scope is auto-named, so by default this samples the parent SLICE (the aggregate of
# every daemon scope + its workers + kernels), auto-discovered under the cgroup tree. Override
# with SCOPE_CGROUP to sample a specific cgroup dir.
#
# Usage: [SCOPE_CGROUP=/sys/fs/cgroup/.../prime-agent.slice] [INTERVAL=30] \
#        [OUT=~/.prime/agent/telemetry.jsonl] [MAX_BYTES=10485760] telemetry-sampler.sh
set -eu
INTERVAL="${INTERVAL:-30}"
OUT="${OUT:-$HOME/.prime/agent/telemetry.jsonl}"
MAX_BYTES="${MAX_BYTES:-10485760}"
SLICE_NAME="${SLICE_NAME:-prime-agent.slice}"
uid=$(id -u)

discover_slice_cgroup() {
  # Prefer an explicit override, else find the slice dir once under the cgroup2 tree.
  if [ -n "${SCOPE_CGROUP:-}" ]; then
    printf '%s\n' "$SCOPE_CGROUP"
    return
  fi
  find /sys/fs/cgroup -type d -name "$SLICE_NAME" 2>/dev/null | head -n1
}

SCOPE_CGROUP="$(discover_slice_cgroup)"

read_first() { [ -r "$1" ] && head -n1 "$1" 2>/dev/null || printf ''; }
meminfo_kib() { awk -v k="$1" '$1==k":"{print $2}' /proc/meminfo 2>/dev/null || printf ''; }

# pgrep -c prints "0" AND exits 1 when nothing matches; capturing it directly would append a
# second "0" via a `|| echo 0` and produce invalid JSON. Assign then default on failure so the
# value is always a single integer. -u scopes the count to this user, not the whole host.
count_procs() {
  c=$(pgrep -u "$uid" -c -x "$1" 2>/dev/null) || c=0
  [ -n "$c" ] || c=0
  printf '%s' "$c"
}

rotate_if_large() {
  # Single-generation rotation so the sampler cannot fill the disk over a long run.
  if [ -f "$OUT" ]; then
    size=$(wc -c < "$OUT" 2>/dev/null || echo 0)
    if [ "$size" -gt "$MAX_BYTES" ] 2>/dev/null; then
      mv -f "$OUT" "$OUT.1" 2>/dev/null || :
    fi
  fi
}

mkdir -p "$(dirname "$OUT")" 2>/dev/null || :
while :; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mem_current=""; swap_current=""
  if [ -n "$SCOPE_CGROUP" ]; then
    mem_current=$(read_first "$SCOPE_CGROUP/memory.current")
    swap_current=$(read_first "$SCOPE_CGROUP/memory.swap.current")
  fi
  mem_avail_kib=$(meminfo_kib MemAvailable)
  swap_free_kib=$(meminfo_kib SwapFree)
  workers=$(count_procs prime-agent)
  kernels=$(count_procs python)
  rotate_if_large
  printf '{"ts":"%s","slice_cgroup":"%s","scope_memory_current":"%s","scope_swap_current":"%s","mem_available_kib":"%s","swap_free_kib":"%s","prime_agent_procs":%s,"python_procs":%s}\n' \
    "$ts" "$SCOPE_CGROUP" "$mem_current" "$swap_current" "$mem_avail_kib" "$swap_free_kib" "$workers" "$kernels" >> "$OUT"
  sleep "$INTERVAL"
done
