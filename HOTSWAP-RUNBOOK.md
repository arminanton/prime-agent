# Prime Agent hot-swap retirement runbook

This runbook is for an operator deploying a reviewed build into a blue/green runtime slot.
It describes the bounded v1 update-restart bridge. It is not permission to deploy during a build task.

## Preconditions

1. Identify the live slot, the idle target slot, the exact shared daemon socket, and the shared agent directory.
   Read deployment pointers and durable ownership state. Do not infer them from the current working directory.
2. Keep the live slot and its venv unchanged. Do not move the repository anchor or rebuild a shared live venv.
3. Build and test the candidate in a build worktree. Stage that reviewed build in the idle runtime slot only.
   Prebuild that slot's named venv family, single-threaded, before cutover. Do not bootstrap during retirement.
4. Inspect any retained update manifest and worker holds. Never move or delete manifests by a wildcard.
   A retained manifest may be the only checkpoint for an unresolved session.
5. Verify host health, rollback availability, socket/agent-directory equality, and the existing containment policy.
   A hot-swap does not authorize unrelated memory-cap or host-service changes.
6. For this bridge, the compatibility gate must show no changes from its base:
   protocol `7`, schema `protocol-7-schema-29-f50bed649543`, update format `1`, owner version `1`, session version `3`.
   Keep daemon appVersion pinned too. Old idle clients probe protocol/schema/appVersion, not only
   the socket. A future bump can make them classify an idle successor as stale and relaunch their
   old build. Update that probe or the old clients before attempting a version-skewed hot-swap.

Only put slot-specific kernel/runtime variables in the chosen coordinator/daemon environment.
Client and login environments must not override workers with stale slot-specific runtime paths.
Use a scrubbed, explicit environment for an approved deployment. Do not inherit daemon-worker roles,
session lease identities, or RLM session coordinates from the agent performing the deployment.

## Cutover

Run the detached built-in coordinator from the frozen IDLE TARGET SLOT, not from the active slot,
a build worktree, or a launcher that follows a mutable active pointer. Pin the exact socket and agent directory.
Keep the coordinator outside the predecessor's process group. A service wrapper must not kill its
new daemon descendants when the coordinator exits.

On a systemd user-service host, the invocation form is below. Replace every uppercase path/name
placeholder from the preflight record BEFORE running it. Use a fresh unit name. The status path may
be reused for an immediate recovery retry; the coordinator preserves its previous v1 result first.
Omit the origin flag when there is no initiating agent session.

```sh
systemd-run --user --unit=prime-agent-deploy-UNIQUE --collect \
  --slice=prime-agent.slice -p KillMode=process -- \
  /usr/bin/env -i HOME=/OPERATOR/HOME USER=OPERATOR LOGNAME=OPERATOR \
  PATH=/PINNED/NODE/BIN:/usr/local/bin:/usr/bin:/bin \
  TMPDIR=/CONFIGURED/DAEMON/TMP XDG_RUNTIME_DIR=/run/user/UID \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/UID/bus \
  PRIME_AGENT_CODING_AGENT_DIR=/EXACT/SHARED/AGENT/DIR \
  PRIME_AGENT_KERNEL_VENV=/TARGET/SLOT/VENV/FAMILY \
  PRIME_AGENT_DAEMON_SCOPE=1 PRIME_AGENT_MAX_CONCURRENT_KERNEL_BOOTS=2 \
  PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS=86400000 \
  /ABSOLUTE/IDLE/SLOT/prime-agent.sh --dist update --internal-update-restart-coordinator \
  --daemon-socket /EXACT/SHARED/daemon.sock \
  --internal-update-restart-status /EXACT/SHARED/AGENT/DIR/update-restarts/deploy-UNIQUE.json \
  --internal-update-restart-origin CURRENT_ACTIVE_SESSION_ID
```

This is an approved-deployment template, not a build/test command. Do not replace the pinned target
path with the active-pointer wrapper. Use the equivalent detached containment mechanism on other hosts.
The slot's prime-agent.sh stamps PRIME_AGENT_BUILD_ID from that checkout's git description.
For a direct bundle launch, verify its embedded build label or set the exact frozen buildId explicitly.
Never inherit an unrelated build label. Build labels do not prove that mutable slot contents stayed frozen.

The coordinator performs this sequence:

1. Acquire per-socket coordinator exclusion and global shutdown admission.
2. PREPARE drains mutations, checkpoints sessions, commits workers, and attempts their preservation stop.
   The RPC budget is 210 seconds. The pre-COMMIT readiness budget remains 100 seconds.
3. Capture the durable worker inventory after successful PREPARE. Only workers also named by that
   manifest's root/discard dispositions belong to this run's force-retirement authority.
4. Request predecessor shutdown and wait for its exact process identity to retire.
5. If the fence times out, automatic supervisor escalation requires all four facts:
   - G1: successful PREPARE RPC or confirmed-dead-predecessor manifest provenance.
   - G2: shutdown RPC accepted.
   - G3: socket unreachable.
   - G4: fence pid, start identity, owner token, generation and socket match the prepared predecessor.
6. Recheck pid/start identity immediately before each signal. Use exact positive pids only.
   The ladder is SIGTERM, up to 3 seconds, SIGKILL, then up to 2 seconds for confirmation.
   Only captured committed workers may also receive that ladder, with shutdown acceptance (G2)
   and socket unreachability (G3) still required. Otherwise survivors become holds. Nonmembers are never signaled.
7. Keep shutdown admission while issuing a private target ticket and launching the successor.
   The ticket binds socket, canonical agent/descriptor directories, buildId and physical entrypoint.
   It never overrides the predecessor startup fence or ordinary live-owner exclusion.
8. Validate the successor's protocol, schema, version, distinct owner, buildId, physical entrypoint and
   local admission claim before releasing admission and restoring sessions.
9. Clear the manifest only after restoration into a validated successor has no recovery failures.

Set `PRIME_AGENT_UPDATE_RESTART_NO_ESCALATION=1` to disable automatic force escalation.
A refusal or permission error is reported as blocked. It is not authority to remove live fences.
Set `PRIME_AGENT_UPDATE_RESTART_ALLOW_SAME_BUILD=1` only for a deliberate real restart of the
already-live target. It performs PREPARE/cutover rather than the default skip/continuation guard.
Pending checkpoints still obey prior-result suppression. This flag is not permission to replay resolved work.

Running the coordinator from the idle target makes the new escalation available on the FIRST install,
even when the predecessor still has the old unbounded server-close code. Later deployments also have
the hardened predecessor teardown: one second FIN grace, two second server-close bound, and an unref
45 second supervisor/worker backstop. Supervisor stage ceilings total 42 seconds.

## Client behavior

Once the retiring daemon includes the reconnect fix, a completed PREPARE makes its closing
notice `update`, not `shutdown`. Attached TUI and Agents View windows take the existing
in-place reconnect path. This also benefits old clients that already understand `update`.
The wire shape and all compatibility versions stay unchanged.

Updated TUI adapters wait up to 120 seconds for a new supervisor generation, then allow a
fresh 120 seconds to find and attach the restored session. They never use `retry_worker`
to race the coordinator's manifest restoration. An update already in progress owns its
failure deadline, even if an older predecessor sends a conflicting shutdown notice.
A routed client can receive the update notice over its direct worker link while the supervisor
hello is pending. The worker hello has no supervisor generation; that case uses the bounded
compatibility fallback and update precedence, not a guaranteed predecessor-generation gate.
Stable-envelope replay for non-update transport loss remains unchanged, including signal-bearing
startup prompts and ACP prompt-and-wait. If update rejects an old-ID replay, the client reports
unknown admission without cancelling the restored session. Successful acknowledgments remain authoritative.
The red diagnostic with session ID, saved file and log path is the fallback after recovery
fails. A genuine shutdown with no prepared update still closes the session window normally.

Prepared is sticky: any later stop, including a manual stop or `--force`, is labelled `update`.
Handled crash/signal shutdown also sends `update` in this phase, where the old code sent an
unlabelled close. Updated TUIs take the update deadline rather than the ordinary reconnect
path; Agents View also attempts recovery. If the coordinator died after PREPARE, no successor
may arrive and clients reach the bounded fallback. Preserve the manifest and follow the recovery procedure rather than replaying work.
A failed preparation resets the supervisor phase. Direct peers can already have received an
early update notice during preparation; if preparation then cancels without a successor,
updated clients can time out waiting for a new generation. Watchers sharing that transport
can reach the same fallback. The surviving session is intact and can be reopened.

Canceled-prepare reattach is intentionally NOT implemented. Cancel is not cleanly detectable
client-side: a same-generation hello, a ready row, and even a successful attach do not prove
cancel. The supervisor can serve a cached snapshot, raw worker attach is read-only during
preparation, and asynchronous `worker_subscribe` failures are swallowed. A safe implementation
requires a dedicated wire-level cancel signal. The bounded terminal fallback is retained as
the safe behavior. Revisit this only if the protocol gains that signal; same-generation
probes must not consume the separate 120-second post-successor restoration budget.

Bootstrap: the first install still retires the unfixed `39ae91e6` daemon. Its already-attached
old clients can still go terminal on that cutover. Do not promise first-install seamlessness.
A pre-updated client can resist the conflicting notice, but running old JavaScript cannot
hot-load that client protection. Later cutovers gain the fixed predecessor notice.
Updated clients clear stale local working, compaction, refinement, retry and goal indicators
when reconnect begins. They preserve drafts and queue edits, then restore local presentation
from the existing resync and connected paths. After the gap, subagent counts use child
snapshots until a roster callback after reconnection supplies fresh data. Missing child
metadata can hide the count tile; it does not mark a child as stopped. Fresh events on a
surviving direct link still reach the view.

Reconnect aborts manual trace upload requests and prevents late progress, results or editor
clears from changing the resumed view. The existing trace transport can detach its abort
listener after response headers, so cancellation of an already-returned response body is
not guaranteed; late body results are still ignored locally. Automatic uploads and the
existing Ctrl+C policy are unchanged. Missing pre-gap retry countdown and refinement-progress details
are not reconstructed from snapshots. Kernel RAM and mid-turn external effects remain
best-effort, not zero-loss guarantees.

Never signal or kill a TUI/client to release the daemon. The daemons close their own accepted socket ends.
A stopped client is not a dead process. Zombies count as exited; stopped and unobservable processes do not.

## Outcomes and recovery

| Outcome | Meaning and action |
| --- | --- |
| `complete`, no failures | Target identity validated and all checkpoints restored. Verify sessions and health before changing deployment pointers. |
| `complete`, recovery failures | Other sessions restored, but listed sessions are held or degraded. Keep the manifest. Inspect each failure and its matching local descriptor annotation. This is not a zero-loss result. |
| `skipped`, already live target | No second cutover was run. Verify the live target. |
| `blocked: predecessor ... survived SIGKILL (uninterruptible)` | The supervisor is still alive. No successor starts. Keep its fence and manifest. Re-run only after that exact process retires. Never revoke its ownership to force progress. |
| Worker survives SIGKILL or its identity is unknown | That worker's sessions remain recovery-uncertain. Their live leases/evidence are retained and other sessions may restore. A pending SIGKILL completes when uninterruptible I/O returns. |
| PREPARE reply missing while predecessor lives | File age is not commit proof. No automatic force authority is inferred. Keep evidence and reconcile before retrying. |
| `automatic escalation refused: G1` after idle-manifest reuse | Deliberately blocked. An idle re-run is not a successful PREPARE RPC in this run. Do not forge provenance or remove its live fence; reconcile that exact predecessor under the operator's separate recovery policy. |
| Dead predecessor, live workers without matching hold evidence | No committed inventory is available for those workers. The run blocks without signaling them. |
| Wrong build or physical slot answers | No restore into that daemon. Keep the manifest and reconcile ownership before retrying from the intended slot. |

A retry recognizes only local holds bound to the same manifest timestamp, root and exact descriptor identity.
It adds no new signaling authority. A still-live held worker can block a later fresh PREPARE.
After its process retires, normal preservation reclaim and a restore retry can finish its recovery.
Do not discard the hold or cancel its schedules merely to make the next deploy pass.

If the exact target is already live with a retained SOCKET-SCOPED manifest, automatic continuation
requires a prior local v1 status bound to both that live successor identity and the same
manifestCreatedAt checkpoint. An unscoped legacy manifest is not used in this branch.

The bound result must account for every checkpoint. Only files classified held or create_failed
can be retried, and only when they are not already active. Parent IDs are remapped from live sessions.
A previously resolved session stays resolved even if the user later closed it: it is not recreated.
Degraded, already-active, or unclassified failures are retained for manual inspection, never replayed.
Counts describe checkpoint resolution, not a promise that every previously restored session is still open.

The same checkpoint-history suppression applies when reusing a pending manifest through an idle
predecessor, a confirmed-dead predecessor, or no-daemon recovery. Once restoration history exists,
those routes also skip resolved/degraded files and retry only classified eligible failures.
A checkpoint with no prior restoration history retains the original v1 first-handoff recovery behavior.
This does not grant any new signaling authority or relax target validation.

A progress count is written AFTER effects. An incomplete result cannot prove that its first unreported
session was never activated. Therefore unbound or incomplete prior results refuse automatic continuation
and retain the manifest. The latest incomplete retry is not replaced with an older complete result.
This conservative bridge does not add the deferred result-before-ACK command protocol.

Coordinator exclusion is acquired before writing status. Informational mirrors from losing coordinators
cannot authorize continuation. Reusing an output pathname preserves its prior v1 status in the existing
update-restarts history before writing the new result. Keep this history while recovery is unresolved.

A target-claim verification failure remains strict even if build/realpath validation passed. No restore
is sent in that attempt. A status that explicitly records those never-started failures can authorize
an immediate bound retry into the still-live target. Missing or ambiguous evidence requires an operator
decision. Do not erase evidence to turn a refusal into an apparent success.

The kernel warning `final kernel snapshot skipped: kernel did not settle` names the affected session.
A frozen kernel's uncheckpointed variables cannot be recovered by this procedure. Interruption notices
can also appear after force retirement. Verify external tool effects before continuing uncertain work.

## Verification and rollback

- Inspect final status, counts, failures and optional escalation records. A cleanup-release warning
  after validated restore is not the same as a failed cutover.
- Verify the live executable's physical slot and buildId, exact socket/agent directory, expected sessions,
  a representative heartbeat, and containment. Match any held descriptor to its recovery evidence.
- Only after verification, update active/idle pointers and the deployment ledger. Preserve the rollback slot.
- There is no automatic rollback. Re-running a completed target normally skips another cutover.
- If manual rollback is required, run its coordinator from the selected rollback slot. An old slot has
  its old coordinator and does not gain this bridge's escalation or target-admission guarantees.
  Prefer forward recovery after sessions have resumed; rollback can duplicate resumed external work.
- A legacy predecessor may already have completed an erroneous terminal archive before retirement.
  The bridge can undo newly introduced stop/archive flags only on exact retained committed descriptors.
  It cannot undo a descriptor deletion or historical subagent archive that already finished.

This slot procedure requires a real entrypoint path. Bun single-binary invocations without such a path
fail target preflight and need a separate identity design. No binary-only deployment is claimed here.
Legacy unscoped manifests remain readable for explicit no-daemon/prepare recovery, so inspect them
before a deployment; their historical lack of socket binding is not repaired by a file-age rule.

The versioned skill addendum is at `deploy/hotswap/prime-agent-hot-swap-deploy/SKILL.md`.
Synchronize any installed host skill only after review. Older host notes promising unconditional
zero-loss or first-install reconnect, client killing, or blanket manifest cleanup are not this procedure.
