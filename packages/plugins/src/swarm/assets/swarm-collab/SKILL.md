---
name: swarm-collab
description: Peer blackboard collaboration and orchestration rules for multi-role Author and Verifier squads (zero-coding coordinator, worktree isolation, #seq pointers, wake doorbell, and two-mode close)
managedByPlugin: builtin:swarm
---

# Swarm Blackboard Collaboration Rules

Follow these four hard rules whenever coordinating or participating in a `builtin:swarm` collaboration group:

## 1. Zero-Coding Coordinator Rule

- The coordinator conversation (`swarm-coordinator`) only splits work, dispatches named peer roles (`swarm_dispatch_worker`), resolves cross-slice blockers, and performs final branch merging after closing the group.
- Never write business code or run long builds directly inside an active coordinator session; `coordinatorGuard: true` strips heavy tools (`edit`, `write`, `bash`, `subagent`, `SubagentWorkflow`) to keep blackboard triage responsive.

## 2. Non-Overlapping Slices and Author/Verifier Separation

- Give every concurrent code-writing member non-overlapping file ownership and `isolation: 'worktree'` so parallel edits never collide on disk.
- Pair every 2 to 4 `access: 'readwrite'` Authors with 1 `access: 'readonly'` Verifier.
- A `readonly` Verifier runs builds, typechecks, lints, and tests via `bash`, audits diffs via `swarm_inspect_worker` or `builtin:workflow.inspect_worktree`, and posts `kind: 'review'` via `swarm_board_post` back to the owning Author on defects or `kind: 'done'` to `coordinator` when clean. A Verifier never edits files directly.

## 3. `#seq` Pointer Handoffs (Zero Copy-Paste)

- Reference prior board posts via `refs: [seq]` and `#seq` in the post body instead of copy-pasting diffs, logs, or long peer reports across turns.
- When a `worktree`-isolated member posts `kind: 'handoff'` or `kind: 'done'` via `swarm_board_post`, the board automatically attaches a `worktreeSnapshot` (`worktreeId`, `branch`, `commitsAhead`, `dirtyCount`, `changedFilesPreview`). Peers inspect full diffs directly from that worktree.

## 4. `wake` Doorbell and Two-Mode Close Discipline

- `wake: true` is a wakeup doorbell, never a CC. Every woken target pays a model turn.
- On peer-to-peer handoffs (`author -> verifier` or `verifier -> author`), wake only the next peer who must act; do not include `coordinator` until final `done` delivery or an unresolvable `blocker`.
- Use `kind: 'comment'` (`wake: false` by default) for passive status notes, and end your turn silently instead of posting pure acknowledgments ("ack", "thanks", "received").
- Never close the group while `activeWorkingMembers` is non-empty. Once all slices pass verification and unmerged worktree branches remain, call `swarm_close_group({ keepWorktree: true })` to release worktree holds, preserve modified branches, strip `swarm-coordinator` to restore `bash`, merge the retained branches cleanly, and then clean up worktrees.
