#!/usr/bin/env bash
# Prime Agent daemon containment verifier (Deploy A, M6). NOT run by the fix branch.
#
# The cutover gate must check the EFFECTIVE cgroup cap, not just membership: an implicitly created
# or misconfigured UNCAPPED prime-agent.slice of the same name would otherwise pass a
# membership + memory.current check. This asserts, for THIS user's prime-agent.slice cgroup
# (resolved via its ControlGroup, NOT the first same-named dir found under /sys/fs/cgroup):
#   1. the memory controller is present and readable,
#   2. memory.max is a positive integer (NOT "max"/unbounded; matches EXPECT_MEMORY_MAX_BYTES if set),
#   3. memory.swap.max is a non-negative integer (NOT "max"/unbounded; matches EXPECT_MEMORY_SWAP_MAX_BYTES if set),
#   4. memory.oom.group == 0,
#   5. (unless SKIP_MEMBERSHIP=1) every prime-agent / python process of this user is under the slice,
#   6. the client-errors log has no daemon-scope fallback marker (containment NOT applied).
# Exit 0 only when ALL pass, so a deploy step can gate on it. Run it BEFORE removing the
# user-400.slice MemoryHigh soft cap AND again after the update-restart.
#
# Overrides (for testing / explicit control):
#   SLICE_CGROUP=/abs/cgroup/dir   use this cgroup dir directly (skip ControlGroup resolution)
#   SLICE_NAME=prime-agent.slice   the slice unit name to resolve
#   EXPECT_MEMORY_MAX_BYTES=N      require memory.max to equal N exactly
#   EXPECT_MEMORY_SWAP_MAX_BYTES=N require memory.swap.max to equal N exactly
#   SKIP_MEMBERSHIP=1              skip the process-membership check (cap-only run)
#   CLIENT_ERROR_LOG=/path         client-errors log to scan for the fallback marker
#   FALLBACK_MARKER="..."          override the marker text
set -u

SLICE_NAME="${SLICE_NAME:-prime-agent.slice}"
FALLBACK_MARKER="${FALLBACK_MARKER:-cgroup containment NOT applied}"
CLIENT_ERROR_LOG="${CLIENT_ERROR_LOG:-$HOME/.prime/agent/logs/client-errors.log}"
fail=0
note() { printf '%s\n' "$*"; }
bad() { printf 'FAIL: %s\n' "$*"; fail=1; }
ok() { printf 'PASS: %s\n' "$*"; }

# 1. Resolve THIS user's slice cgroup dir via its ControlGroup, not the first same-named dir.
resolve_slice_cgroup() {
  if [ -n "${SLICE_CGROUP:-}" ]; then
    printf '%s\n' "$SLICE_CGROUP"
    return 0
  fi
  local rel
  rel="$(systemctl --user show -p ControlGroup --value "$SLICE_NAME" 2>/dev/null)"
  if [ -z "$rel" ]; then
    return 1
  fi
  # ControlGroup is a path relative to the cgroup2 mount root.
  printf '%s\n' "/sys/fs/cgroup${rel}"
}

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

assert_numeric_cap() {
  # $1 = human label, $2 = file path, $3 = expected-exact-or-empty
  local label="$1" path="$2" expect="$3" value
  if [ ! -r "$path" ]; then
    bad "$label: controller file missing or unreadable ($path)"
    return
  fi
  value="$(head -n1 "$path" 2>/dev/null)"
  case "$value" in
    max|infinity|"")
      bad "$label is unbounded or empty (\"$value\") -> the slice is effectively UNCAPPED"
      return
      ;;
  esac
  if ! is_uint "$value"; then
    bad "$label is not a non-negative integer (\"$value\")"
    return
  fi
  if [ -n "$expect" ] && [ "$value" != "$expect" ]; then
    bad "$label=$value does not match the expected $expect"
    return
  fi
  ok "$label=$value (bounded)"
}

CG="$(resolve_slice_cgroup)" || true
if [ -z "${CG:-}" ] || [ ! -d "$CG" ]; then
  bad "could not resolve an existing cgroup dir for $SLICE_NAME (ControlGroup empty or dir missing: \"${CG:-}\")"
  note "Is the scoped daemon running (PRIME_AGENT_DAEMON_SCOPE=1) and the slice loaded?"
  exit 1
fi
note "slice cgroup: $CG"

# 2-4. Effective caps.
assert_numeric_cap "memory.max" "$CG/memory.max" "${EXPECT_MEMORY_MAX_BYTES:-}"
assert_numeric_cap "memory.swap.max" "$CG/memory.swap.max" "${EXPECT_MEMORY_SWAP_MAX_BYTES:-}"
if [ ! -r "$CG/memory.oom.group" ]; then
  bad "memory.oom.group missing or unreadable ($CG/memory.oom.group)"
else
  oomg="$(head -n1 "$CG/memory.oom.group" 2>/dev/null)"
  if [ "$oomg" = "0" ]; then
    ok "memory.oom.group=0 (single-process OOM kill, not whole-tree)"
  else
    bad "memory.oom.group=\"$oomg\" (expected 0 for Deploy A)"
  fi
fi

# 5. Membership: every prime-agent / python process of this user is under the slice subtree.
if [ "${SKIP_MEMBERSHIP:-0}" != "1" ]; then
  uid="$(id -u)"
  slice_leaf="${SLICE_NAME}"
  stray=0
  checked=0
  for comm in prime-agent python; do
    for pid in $(pgrep -u "$uid" -x "$comm" 2>/dev/null); do
      checked=$((checked + 1))
      cg_line="$(cat "/proc/$pid/cgroup" 2>/dev/null || printf '')"
      case "$cg_line" in
        *"$slice_leaf"*) : ;;
        *) bad "pid $pid ($comm) is NOT under $slice_leaf: ${cg_line:-<unreadable>}"; stray=$((stray + 1)) ;;
      esac
    done
  done
  if [ "$checked" -eq 0 ]; then
    note "membership: no prime-agent/python processes found for uid $uid (nothing to place)"
  elif [ "$stray" -eq 0 ]; then
    ok "membership: all $checked prime-agent/python processes are under $slice_leaf"
  fi
fi

# 6. No fallback (containment NOT applied) in the client-errors log.
if [ -r "$CLIENT_ERROR_LOG" ] && grep -qF "$FALLBACK_MARKER" "$CLIENT_ERROR_LOG" 2>/dev/null; then
  bad "client-errors log records a scope fallback (\"$FALLBACK_MARKER\") -> a launch ran UNSCOPED"
  note "  $CLIENT_ERROR_LOG"
  note "  Fix systemd-run / the slice and restart before removing the soft cap."
else
  ok "no scope-fallback marker in the client-errors log"
fi

if [ "$fail" -ne 0 ]; then
  note "CONTAINMENT VERIFICATION FAILED - do NOT remove the soft cap / proceed with the cutover."
  exit 1
fi
note "CONTAINMENT VERIFIED."
exit 0
