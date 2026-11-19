---
name: tasks
description: Use in any conversation when the user wants to delegate well-defined units of work to a task board instead of doing them inline — collect requirements into self-contained briefs, wire multi-step efforts with dependencies, then track progress, review submissions, approve or send back for rework. Not for tiny questions you should just answer directly.
managedByPlugin: builtin:tasks
---

# Task Board Delegation

Use `builtin:tasks` when work should run in **independent execution conversations** while the current conversation stays a planning and review cockpit. Each task gets its own top-level human-owned conversation with full orchestration rights (`subagent`, `SubagentWorkflow`, `Swarm`), a 4-column board (Backlog / In Progress / In Review / Done), and an honest live status trail.

## 1. When to Use, When Not to Use

- **Use `tasks` when**:
  - The user asks to "make this a task", "put this on the board", "delegate this", or plans multi-step work that deserves its own execution context.
  - You are decomposing a larger effort into several units, some of which must wait for others (`dependsOn` chains auto-start when prerequisites pass review).
  - The user wants to track who is doing what, review submissions, and approve/rework — instead of scrolling one giant conversation.
- **Do NOT use `tasks` when**:
  - The request is a quick question or a small direct edit: just do it in the current conversation.
  - The work is a fixed, repeatable pipeline with strict gates: prefer `SubagentWorkflow`.
  - The task needs live peer cross-talk between slices: prefer a `swarm` group.

## 2. Planner Rule: Collect Requirements, Do Not Do the Work

- Your job in the planning conversation: clarify intent, shape a **self-contained brief**, choose the executor, wire dependencies, then create the card. Do not write the business code yourself.
- A good `brief` is readable by a fresh conversation with zero context:
  - **Background**: why this work exists, links to prior decisions.
  - **Scope**: exact deliverables and explicit non-goals.
  - **Acceptance criteria**: checkable statements the assignee can verify.
  - **Coordinates**: target repo/directory (cwd), node, branch conventions, and any commands to run.
- Confirm with the user before mass-creating cards (e.g. "3 tasks wired T-1 -> T-2 -> T-3, start now?"). A plain "开工吧" / "go ahead" is enough confirmation.

## 3. Choosing Executor, Node, and Directory

- `assigneeProfileId`: pick the profile that matches the work (default falls back to plugin config `defaultAssigneeProfile`, then this conversation's profile, then `assistant`). Verify the profile exists and is selectable.
- `nodeId` / `cwd`: default to the executor profile's binding, then the current conversation's coordinates. **Remote nodes require an explicit cwd** — never assume a remote node's default directory.
- `planFirst: true` when the approach is risky or contested: the assignee must call `task_request_plan_approval` with its plan; a real Ask card blocks until the user explicitly approves or rejects, and `task_submit` is refused until an approval is recorded.
- `autoMerge: false` (default) keeps the assignee on an isolated branch; only you merge after review. Set `true` only for trusted routine work.

## 4. Splitting into Dependency Chains

- Create one card per independently reviewable unit. Wire order with `dependsOn: ['T-1']`.
- A blocked card stays in `backlog` with `autoStartOnUnblock` (default true); when all prerequisites reach `done`, the next card starts automatically (respecting `maxConcurrentTasks`).
- Keep chains shallow and reviewable; if a "task" needs three sub-managers, it is probably several tasks.

## 5. Running the Board

- Check status: `task_list` (filters: column / project / assignee / node), `task_inspect` for one task with live conversation state, recent entries, artifacts, and dependency status.
- Review: when a card reaches `in_review`, read its `submission` (summary, verification, branch, changed files). Then:
  - `task_approve` (default `close_only`): marks done, archives the execution conversation, unblocks/downstream auto-start.
  - `task_approve` with `mergeAction: 'merge_and_close'`: explicitly authorizes the merge now (overriding autoMerge=false for this closure); the assignee merges, cleans up, and its evidence-bearing `task_submit` (branch or verification) completes the task in one step.
  - `task_rework` with concrete `feedback`: returns the card to in_progress and delivers the feedback to the execution conversation.
- Be honest: never approve work you have not checked; never fabricate progress. If a card shows "stalled" (turn settled without submission) or a missing conversation, surface it to the user instead of papering over it — the plugin never auto-nudges a human-owned execution conversation; ask the user to open the conversation and continue explicitly, or send it back with `task_rework`.

## 6. Tool & CLI Reference

- Model tools (planning side): `task_create`, `task_list`, `task_inspect`, `task_start`, `task_approve`, `task_rework`.
- Assignee side (inside a task execution conversation): `task_submit` (summary + verification + branch + changed files) is the only way to hand in work — it must be called before the assignee ends.
- CLI equivalents: `helmx tasks create|list|inspect|update|start|submit|approve|rework|archive|delete`.
