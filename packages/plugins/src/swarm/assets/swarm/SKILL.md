---
name: swarm
description: Dynamic multi-agent peer blackboard collaboration and parallel orchestration (when to activate via /skill:swarm or swarm_create_group, zero-coding coordinator guard, dynamic role sizing and worktree isolation, #seq pointer handoffs, wake doorbell, and two-mode close)
managedByPlugin: builtin:swarm
---

# Swarm Multi-Agent Peer Collaboration

Use `builtin:swarm` when a task benefits from dividing non-overlapping work across multiple concurrent peer agents, running parallel investigation slices, or pairing writers with read-only cross-verifiers on a shared blackboard. For single-thread tasks use normal execution; for deterministic JS pipeline graphs use `builtin:workflow`.

## 1. When to Use & How to Activate

- **Explicit `/skill:swarm <task>` entry**: When the user sends `/skill:swarm <task>` (or `/skill:swarm`) in a top-level human conversation, `builtin:swarm` automatically activates (or reuses) a collaboration group on that conversation and unlocks the `swarm_*` tools in the same turn.
- **Model-initiated or natural-language activation**: When in a normal top-level conversation you judge that multi-agent parallel division is warranted (or the user asks for multi-agent collaboration in natural language) and no active group exists yet, call `swarm_create_group` first (keeping the default `coordinatorGuard: true`) to open the collaboration board on the current conversation, then recruit and schedule peer workers on the following step.
- **Top-level only**: Collaboration groups can only be started on top-level human conversations—never from a worker or child sub-conversation.
- **Tools vs CLI**: Inside Helm conversations, drive `builtin:swarm` with the `swarm_*` tools (`swarm_create_group`, `swarm_dispatch_worker`, `swarm_board_post`, `swarm_board_read`, `swarm_board_status`, `swarm_inspect_worker`, `swarm_abort_worker`, `swarm_switch_worker_model`, `swarm_archive_worker`, `swarm_close_group`); the equivalent host CLI interface is `helm swarm <subcommand>` (e.g., `helm swarm create-group`, `helm swarm dispatch-worker`, `helm swarm board-status`, `helm swarm close-group`).

## 2. Zero-Coding Coordinator Rule

- The coordinator conversation (`swarm-coordinator`) only decomposes work, dispatches named peer roles (`swarm_dispatch_worker`), resolves cross-slice blockers, and performs final branch merging after closing the group.
- Never write business code or run long builds directly inside an active coordinator session; `coordinatorGuard: true` strips heavy blocking tools (`edit`, `write`, `bash`, `subagent`, `SubagentWorkflow`) to keep blackboard scheduling responsive.

## 3. Dynamic Role Sizing, Permissions, and Workspace Isolation

- Dynamically decide the squad shape on the spot from the task's complexity and file boundaries—never stamp out fixed role-name templates or fixed team sizes.
- When recruiting each worker via `swarm_dispatch_worker`, specify:
  - **`name` & `prompt`**: A unique lowercase member name (avoiding reserved `coordinator`, `all`, `system`) and a focused task prompt with explicit, non-overlapping file ownership.
  - **`access` (`readwrite` vs `readonly`)**: Use `readwrite` for implementation slices; use `readonly` for read-only research or cross-verification (`readonly` strips `edit`, `write`, and `cleanup_worktree` while keeping `bash` for running builds, typechecks, lints, and tests).
  - **`isolation` (`worktree` vs `inherit`)**: Concurrent code-editing members must use `isolation: 'worktree'` so parallel edits never collide on disk; read-only researchers or cross-verifiers may use `isolation: 'inherit'` with `access: 'readonly'`.
  - **Optional overrides**: Set `profileId`, `model`, `effort`, `channels`, or `forkFrom` / `forkEntryId` per worker when specialized personas, heterogeneous models, or subchannels help.

## 4. `#seq` Pointer Handoffs, Orthogonal `wake` Doorbell, and Two-Mode Close

- **Zero copy-paste `#seq` pointers**: Publish progress and handoffs via `swarm_board_post` using `refs: [seq]` and `#seq` in the body instead of copying diffs, logs, or long reports across turns. When a `worktree`-isolated member posts `kind: 'handoff'` or `kind: 'done'`, the board automatically attaches a `worktreeSnapshot` (`worktreeId`, `branch`, `commitsAhead`, `dirtyCount`, `changedFilesPreview`) so peers can inspect diffs directly from that worktree.
- **Orthogonal `wake` doorbell**: `wake: true` is a wakeup doorbell, never a CC—every woken target pays a model turn. On peer handoffs (e.g. writer -> verifier or verifier -> writer), wake only the next responsible actor; do not wake `coordinator` until final `done` delivery or an unresolvable `blocker`. Use `kind: 'comment'` (`wake: false` by default) for passive notes, and end turns silently instead of posting empty acknowledgments ("ack", "thanks", "received").
- **Two-mode close (`swarm_close_group`)**: Never close the group while `activeWorkingMembers` is non-empty. Once all slices pass verification, if no unmerged worktree branches remain call `swarm_close_group()`; if unmerged worktree branches remain, call `swarm_close_group({ keepWorktree: true })` to release worktree holds, preserve modified branches in `retainedWorktrees`, and strip `swarm-coordinator` to restore coordinator `bash`, then merge the retained branches cleanly and clean up worktrees.
