---
name: tasks
description: Use in any conversation when the user wants to delegate well-defined units of work to a task board instead of doing them inline — collect requirements into self-contained briefs, then track progress, review submissions, approve or send back for rework. Not for tiny questions you should just answer directly.
managedByPlugin: builtin:tasks
---

# Task Board Delegation

Use `builtin:tasks` when work should run in **independent execution conversations** while the current conversation stays a planning and review cockpit. Each task gets its own top-level human-owned conversation with full orchestration rights (`subagent`, `SubagentWorkflow`, `Swarm`), a 4-column board (Backlog / In Progress / In Review / Done), and an honest live status trail.

## 1. When to Use, When Not to Use

- **Use `tasks` when**:
  - The user asks to "make this a task", "put this on the board", "delegate this", or plans work that deserves its own execution context and a human review loop.
  - The user wants to track who is doing what, review submissions, and approve/rework — instead of scrolling one giant conversation.
- **Do NOT use `tasks` when**:
  - The request is a quick question or a small direct edit: just do it in the current conversation.
  - The work is a fixed, repeatable pipeline with strict gates: prefer `SubagentWorkflow`.
  - The task needs live peer cross-talk between slices: prefer a `swarm` group.
  - You need cross-task dependency scheduling or concurrency caps: the board is a pure ledger — sequence the work yourself (one task at a time, or via workflow) and only start the next card when the user confirms the previous one passed review.

## 2. Planner Rule: Collect Requirements, Do Not Do the Work

- Your job in the planning conversation: clarify intent, shape a **self-contained brief**, choose the executor, then create the card. Do not write the business code yourself.
- A good `brief` is readable by a fresh conversation with zero context:
  - **Background**: why this work exists, links to prior decisions.
  - **Scope**: exact deliverables and explicit non-goals.
  - **Acceptance criteria**: checkable statements the assignee can verify.
  - **Coordinates**: target repo/directory (cwd), node, branch conventions, and any commands to run.
- Confirm with the user before mass-creating cards (e.g. "3 tasks, start now?"). A plain "开工吧" / "go ahead" is enough confirmation.

## 3. Choosing Executor, Node, and Directory

- `assigneeProfileId`: pick the profile that matches the work (default falls back to plugin config `defaultAssigneeProfile`, then this conversation's profile, then `assistant`). Verify the profile exists and is selectable.
- `nodeId` / `cwd`: default to the executor profile's binding, then the current conversation's coordinates. **Remote nodes require an explicit cwd** — never assume a remote node's default directory.
- Before delegating code work, make sure the brief states the branch discipline explicitly (the board itself no longer carries merge flags): by default the assignee develops on an isolated branch and submits it for review; merging into the main line stays with the human planner unless the brief says otherwise.

## 4. Running the Board

- Check status: `task_list` (filters: column / project / assignee / node), `task_inspect` for one task with live conversation state, recent entries, and artifacts.
- Review: when a card reaches `in_review`, read its `submission` (summary, verification, branch, changed files). Then:
  - `task_approve`: marks done and archives the execution conversation (idempotent on done).
  - `task_rework` with concrete `feedback`: returns the card to in_progress and delivers the feedback to the execution conversation.
- Merging is a human decision outside the board: if the submission looks good and the user wants it merged, either merge it yourself per the project merge rules, or tell the assignee conversation explicitly — the board never orchestrates Git merges itself.
- Be honest: never approve work you have not checked; never fabricate progress. If a card shows "conversation idle, not submitted" or a missing conversation, surface it to the user instead of papering over it — the plugin never auto-nudges a human-owned execution conversation; ask the user to open the conversation and continue explicitly, or send it back with `task_rework`.

## 5. Tool & CLI Reference

- Model tools (planning side): `task_create`, `task_list`, `task_inspect`, `task_start`, `task_approve`, `task_rework`; assignee side adds `task_submit`.
- Assignee side (inside a task execution conversation): `task_submit` (summary + verification + branch + changed files) is the only way to hand in work — it must be called before the assignee ends.
- CLI equivalents: `helmx tasks create|list|inspect|update|start|submit|approve|rework|archive|delete`.
