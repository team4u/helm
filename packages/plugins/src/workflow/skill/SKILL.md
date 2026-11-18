---
name: workflow
description: Use when choosing or running subagents and deterministic SubagentWorkflow orchestration, including DSL scripts, parallel pipelines, gates, worktrees, saved definitions, and checkpoint recovery.
managedByPlugin: builtin:workflow
---

# Workflow Orchestration

Use `builtin:workflow` for multi-agent execution and deterministic orchestration. The plugin owns the tools, actions, run ledger, worktree lifecycle, background reports, and recovery semantics described here.

## Choose the execution surface

- Use `subagent` for one focused task delegated to another Profile or external runtime. It is the smallest useful unit and returns one business result plus independent execution metadata.
- Use `SubagentWorkflow` for a deterministic JavaScript graph with multiple agents, parallel branches, staged pipelines, actions, gates, or checkpoint replay. Prefer the native tool in a conversation; use the CLI for terminal or scheduled operation.
- Use `cleanup_worktree` only for a registered managed worktree. Inspect or merge first; never invent a path, branch, or completion result.
- Use `run_action` for a workflow action when the action catalog exposes it. Call `run_action({ actionId, describe: true })` before using an unfamiliar action so nested schemas are read without side effects.

## Operating rules

- Load `references/dsl.md` before writing a non-trivial workflow script. It is the plugin-owned reference for the injected DSL, deterministic restrictions, schemas, and failure handling.
- For a one-off inline script, set `meta.name` or pass a short `label` so the run is identifiable in the task panel.
- A human-owned conversation defaults workflow and subagent starts to background. Return the running handle and continue the conversation; do not sleep or poll. The terminal result is delivered as a steer follow-up.
- An automation-owned conversation defaults to synchronous execution. Do not request `background: true` there; it is rejected to prevent early settlement.
- Use `background: false` only when the next model step depends on the real result. A foreground run can be detached while it is waiting.
- Treat a returned run handle as started, not completed. Wait for the terminal-state report before claiming success.
- Batch results may contain `null` after a branch failure. Check every result and report partial failure explicitly.
- Keep prompts and results JSON-serializable. Do not pass secrets into scripts or claim that a failed or uncertain execution succeeded.

## Worktrees and gates

- Give concurrent code-writing agents `isolation: "worktree"` and non-overlapping ownership. Keep the worktree until its diff has been inspected and merged or deliberately retained.
- Use `gate` for a real verification command in the agent's effective workspace. A non-zero exit is a failed node, not a reason to fabricate a pass.
- After merging, call `cleanup_worktree` with the actual `worktreeId` or the exact registered selector. `force` does not bypass occupancy, ownership, process-use, or uncertain execution checks.

## Saved definitions and recovery

- Use `helm workflows save` for a reusable script and `helm workflows list/get` to inspect the source. Definitions are cross-conversation assets; duplicate names refuse by default.
- Use `resumeFromRunId` for ledger checkpoint replay. Completed idempotent nodes are reused without re-execution; uncertain side effects are refused explicitly.
- `agent(..., { resume })` continues an existing agent conversation. It is different from `resumeFromRunId` and should not be described as ledger replay.
- Inspect failed runs before resuming. Do not double-trigger an automatic recovery or claim recovery when the underlying execution is unavailable.

## References

- `references/dsl.md`: injected JavaScript APIs, examples, determinism rules, limits, and replay behavior.
- `references/subagents.md`: `subagent` options, lifecycle defaults, external runtimes, worktree cleanup, and CLI equivalents.
