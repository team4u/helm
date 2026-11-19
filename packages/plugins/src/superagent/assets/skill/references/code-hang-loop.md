# Handling Code Infinite Loops and Stuck Tests

Applicable: an owned native conversation stays `working` for a long time with a continuously growing stall (e.g. a subagent wrote an infinite-loop test, or a build/script hangs and emits no events at all).

1. First run `watchdog_inspect({ conversationId })` to query the conversation state, recent timeline, and `conversation.activeProcesses`: this is a snapshot of process occupancy in the target conversation's working directory `(nodeId ?? 'local', cwd)`, each item being `{ pid, name, source, path }`. Missing fields mean probing failed (node offline etc.) and must not be treated as "no occupancy".
2. Combine recent messages with `activeProcesses` to locate the stuck process (e.g. `vitest`, `node`, `python` stuck inside a worktree directory; identify the owning directory by `pid` / `name` / `source` / `path`).
3. When the target is an owned (helmx/bot) conversation, use `watchdog_recover({ conversationId, hint })` (`whenBusy: 'steer'`) to write the stuck process's `pid` and `name` into the recovery hint and let that conversation terminate the process and continue on its own; the hint only states facts and never decides for it.
4. Human-owned conversations and all external terminal panes are absolutely read-only: diagnose and notify the human only; keystrokes, recovery injection, or aborts are strictly forbidden.
5. When the stall reaches `abortAfterMs`, the 0-token layer (L1 `autoAbort`) has already aborted the current turn via `abortConversationGuarded`; the outer `goal()` enters the next retry with the error context. Here you only recheck the abort/retry result and report honestly; do not abort again.
6. After recovery, recheck the conversation state and `activeProcesses` to confirm the process has exited; never declare recovery based on model output alone.
