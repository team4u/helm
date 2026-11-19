# Subagent and Runtime Reference

## `subagent`

Use the `subagent` tool for one delegated task. Required input is `prompt`; useful options include `label`, `agentType`, `fork`, `cwd`, `isolation: "worktree"`, `model`, `effort`, `gate`, `schema`, `attachments`, `maxSubagentDepth`, `resume`, and `background`.

- Use a short `label` so the task card and child conversation are identifiable.
- Human-owned conversations default to background. Keep working and wait for the automatic steer report; do not poll or sleep.
- Automation-owned conversations default to synchronous. Explicit `background: true` is rejected for those callers.
- Use `background: false` only when the next step depends on the actual result.
- `fork: true` creates a native child from the parent's completed context. It cannot be combined with `resume` and is unsupported for external runtimes.
- `isolation: "worktree"` keeps the child branch and worktree after the run. Inspect and merge before cleanup.
- `resume` continues an existing execution context. It is not the same as workflow ledger replay.

The business result and execution metadata are separate. Preserve `conversationId`, `executionId`, `effectiveCwd`, and `worktree` when later inspection or cleanup needs them.

## External runtimes

An `agentType` such as `herdr:agy` is routed through the owning external plugin when available. The external pane has its own execution identity and handoff protocol. Do not read terminal screen text as a result or silently fall back to local execution when the target is unavailable.

## Background control

Use the workflow steer action or `helmx workflows steer <runId> --text <guidance>` only for a running background subagent that belongs to the current task tree. The operation is guarded by ownership and the current execution watermark. A successful delivery means the guidance was sent, not that it has already been executed.

## Worktree cleanup

After inspecting or merging a child worktree, call the model tool `cleanup_worktree({ worktreeId: execution.worktree.id })` with the real execution metadata. This is a conversation tool, not a DSL function.

The equivalent CLI is `helmx worktrees cleanup --worktree-id <id> --json`. Cleanup refuses dirty, unmerged, occupied, locked, or uncertain worktrees by default. `force` only addresses the dirty/unmerged protection and never bypasses the other safety checks.
