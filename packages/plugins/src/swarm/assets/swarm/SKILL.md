---
name: swarm
description: Use in top-level human conversations when a complex task needs dynamic multi-agent division, live peer-to-peer handoffs, multi-round writer/verifier review loops, or mid-flight squad adjustments on a shared blackboard — not for single subtasks or fixed deterministic pipelines.
managedByPlugin: builtin:swarm
---

# Swarm Multi-Agent Peer Collaboration

Use `builtin:swarm` for horizontal, adaptive peer collaboration on a shared `#seq` blackboard when roles need to inspect each other's progress, run multi-round write/review cycles, or evolve the team shape as findings emerge.

## 1. When to Use, When Not to Use & How to Activate

- **Use `swarm` when**:
  - Multiple non-overlapping code slices or deep investigation tracks benefit from running concurrently **and** coordinating findings or cross-module contracts on a shared board.
  - Implementation slices need iterative **writer <-> read-only verifier** handoff/review/fix loops before coordinator merge.
  - The squad shape cannot be scripted up front—you may need to recruit extra specialists, steer/abort a stuck peer, or switch a worker's model mid-task while keeping the user conversation responsive.
- **Do NOT open a swarm group when**:
  - **Small or tightly sequential work**: handle it directly in the current conversation.
  - **One isolated subtask** (single lookup, one blind review, one bounded fix): use `subagent` (when enabled) instead of creating a group.
  - **Fixed, repeatable pipelines** (fan-out batch audits without peer cross-talk, staged pipelines, strict `gate`/schema checkpoints, saved/scheduled runs, or orchestration inside a child/automated session): use `SubagentWorkflow` (`workflow` skill, when enabled).
- **Activation & eligibility (top-level human conversations only)**:
  - **Explicit `/skill:swarm <task>` entry**: When the user sends `/skill:swarm <task>` (or `/skill:swarm`) in a top-level human conversation, `builtin:swarm` automatically activates (or reuses) a collaboration group on that conversation and unlocks the `swarm_*` tools in the same turn.
  - **Model-initiated or natural-language activation**: When in a normal top-level conversation you judge that the task matches the criteria above (or the user asks for multi-agent collaboration in natural language) and no active group exists yet, call `swarm_create_group` first to open the collaboration board on the current conversation, then recruit and schedule peer workers on the following step.
  - **Top-level only**: Collaboration groups can only be started on top-level human conversations—never from a worker, child, or automated sub-conversation.
  - **Tools vs CLI**: Inside Helmx conversations, drive `builtin:swarm` with the `swarm_*` tools (`swarm_create_group`, `swarm_dispatch_worker`, `swarm_board_post`, `swarm_board_read`, `swarm_board_status`, `swarm_inspect_worker`, `swarm_abort_worker`, `swarm_switch_worker_model`, `swarm_archive_worker`, `swarm_close_group`); for subchannel management call action `builtin:swarm.manage_channel` via `run_action` (`op`: `create` / `subscribe` / `unsubscribe` / `archive`, `channel`, optional `topic` / `member`). The equivalent host CLI interface is `helmx swarm <subcommand>` (e.g., `helmx swarm create-group`, `helmx swarm channel`, `helmx swarm dispatch-worker`, `helmx swarm board-status`, `helmx swarm close-group`).

## 2. Coordinator Rule: Do Not Do the Work

- The coordinator conversation (`swarm-coordinator`) decomposes work, dispatches named peer roles (`swarm_dispatch_worker`), resolves cross-slice blockers, and performs final branch merging and group closure.
- Do not write business code or sit inside long blocking builds/tests directly in an active coordinator session; delegate implementation, testing, and review fixes to workers so blackboard scheduling and user replies stay responsive. Quick read-only lookups (`read`, `rg`, `git status`, `git diff`) to size and split the work are fine.

## 3. Dynamic Role Sizing, Permissions, and Workspace Isolation

- Dynamically decide the squad shape on the spot from the task's complexity and file boundaries—never stamp out fixed role-name templates or fixed team sizes.
- When recruiting each worker via `swarm_dispatch_worker`, specify:
  - **`name` & `prompt`**: A unique lowercase member name (avoiding reserved `coordinator`, `all`, `system`) and a focused task prompt with explicit, non-overlapping file ownership.
  - **`access` (`readwrite` vs `readonly`)**: Use `readwrite` for implementation slices; use `readonly` for read-only research or cross-verification (verifiers run builds, typechecks, lints, and tests via `bash`, inspect diffs, and post review outcomes via `swarm_board_post` without modifying files).
  - **`isolation` (`worktree` vs `inherit`)**: Concurrent code-editing members must use `isolation: 'worktree'` so parallel edits never collide on disk; read-only researchers or cross-verifiers may use `isolation: 'inherit'` with `access: 'readonly'`.
  - **Optional overrides**: Set `profileId`, `model`, `effort`, `channels`, or `forkFrom` / `forkEntryId` per worker when specialized personas, heterogeneous models, or subchannels help.

## 4. `#seq` Pointer Handoffs, Orthogonal `wake` Doorbell, and Two-Mode Close

- **Zero copy-paste `#seq` pointers**: Publish progress and handoffs via `swarm_board_post` using `refs: [seq]` and `#seq` in the body instead of copying diffs, logs, or long reports across turns. When a `worktree`-isolated member posts `kind: 'handoff'` or `kind: 'done'`, the board automatically attaches a `worktreeSnapshot` (`worktreeId`, `branch`, `commitsAhead`, `dirtyCount`, `changedFilesPreview`) so peers can inspect diffs directly from that worktree.
- **Orthogonal `wake` doorbell**: `wake: true` is a wakeup doorbell, never a CC—every woken target pays a model turn. On peer handoffs (e.g. writer -> verifier or verifier -> writer), wake only the next responsible actor; do not wake `coordinator` until final `done` delivery or an unresolvable `blocker`. Use `kind: 'comment'` (`wake: false` by default) for passive notes, and end turns silently instead of posting empty acknowledgments ("ack", "thanks", "received").
- **Two-mode close (`swarm_close_group`)**: Never close the group while `activeWorkingMembers` is non-empty. Once all slices pass verification, merge worktree branches and call `swarm_close_group()`; or call `swarm_close_group({ keepWorktree: true })` to release worktree holds and preserve modified branches in `retainedWorktrees` for subsequent merging and cleanup.
