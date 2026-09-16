---
name: prime-agent-hot-swap-deploy
description: Guides reviewed Prime Agent blue/green cutovers with bounded retirement, exact target admission, checkpoint restoration, degraded worker holds, and explicit rollback limits. Use when asked to deploy, hot-swap, release, or roll back a local Prime Agent daemon. A build-only task does not authorize a deployment.
---

<objective>
Operate a reviewed hot-swap without signaling clients or racing a live predecessor.
This is the versioned replacement guidance for the bounded v1 bridge. It is not a zero-RAM-loss promise.
</objective>

<quick_start>
Read HOTSWAP-RUNBOOK.md at the root of the reviewed target checkout before any deployment.
Confirm explicit deployment authorization, the live and idle slots, exact shared socket and agent directory,
target buildId and physical entrypoint, prebuilt target venv, health gate, and rollback slot.
If this file is installed elsewhere, resolve that runbook from the reviewed checkout, not the skill directory.
</quick_start>

<essential_principles>
- Run the detached coordinator FROM THE IDLE TARGET SLOT. Its own physical entrypoint is the launch target.
- Never deploy from the build worktree. Never mutate the live or rollback slot during preparation.
- Never rebuild a shared live venv. Prebuild the named target-slot family before cutover.
- Never inherit daemon-worker, session-lease, RLM, or stale client runtime coordinates into deployment commands.
- Never signal/kill a TUI or client. The red daemon_closing screen is expected and carries the session ID.
- Never use manifest age as proof of PREPARE success. Never clear retained checkpoints or fences by wildcard.
- An exact live supervisor that survives SIGKILL is BLOCKED. No target ticket overrides its fence or ownership.
- Surviving committed workers are session-scoped recovery holds. Restore the other sessions and retain evidence.
- Preserve v1 protocol/schema/owner/session/update-format versions for this bridge.
</essential_principles>

<process>
1. Complete the runbook's health, identity, checkpoint and rollback preflight. Build/test completion alone is not deploy approval.
2. Stage the reviewed candidate only in the idle slot and prebuild that slot's runtime family.
3. Launch the existing detached coordinator with a scrubbed, explicit target-slot environment and exact socket.
   Keep the coordinator outside the predecessor process group; do not let service cleanup kill its successors.
4. Let the coordinator own PREPARE, shutdown acceptance, the exit fence, gated exact-pid escalation and target admission.
   Do not emulate this flow with a general shutdown, manual lock deletion, or an old-TUI relaunch.
5. Observe final status and verify target build/realpath, sessions, representative heartbeat and containment.
6. Record degraded holds separately from complete recovery. Reopen restored sessions from Agents View using the red screen's ID.
7. Only after verification, change deployment pointers and append the ledger. Preserve the old slot through confirmation.
</process>

<recovery>
- PRIME_AGENT_UPDATE_RESTART_NO_ESCALATION=1 disables automatic force escalation.
- PRIME_AGENT_UPDATE_RESTART_ALLOW_SAME_BUILD=1 requests a deliberate real same-target cutover, not a harmless retry.
  All checkpoint-history suppression rules still apply.
- Idle-manifest re-runs that reach a fence timeout can fail G1 by design. Keep the live fence and reconcile; never forge provenance.
- A blocked supervisor stays fenced until its exact process retires. Keep its manifest and re-run after that fact changes.
- Unknown worker identities never receive an automatic signal. Matching local holds can carry across retries without new kill authority.
- Already-live exact targets require a prior local status bound to their exact successor identity and checkpoint.
  Retry only classified held/create_failed files that are not currently active. Resolved-then-closed stays closed.
- Unbound, incomplete, degraded, or ambiguous results do not auto-replay. Keep the manifest and prior status history.
- Apply prior-result suppression to every pending-manifest reuse route, not just already-active continuation.
  A first handoff with no restoration history keeps the original v1 recovery behavior; it gains no new signal authority.
- Missing context/actions and skipped kernel snapshots require inspection; retained evidence is not proof all variables survived.
- No automatic rollback. An old rollback slot still has its old coordinator. Forward recovery is usually safer after work resumes.
</recovery>

<success_criteria>
The observed target identity matches the reviewed build and physical slot. The status and session counts are reconciled.
All unresolved holds/degraded sessions are named and retained. No client was signaled, no live ownership was overridden,
and no rollback or zero-loss claim is made without evidence.
</success_criteria>
