# SubagentWorkflow DSL Reference

This is the authoritative model-facing reference for the deterministic JavaScript executed by `SubagentWorkflow`. The script runs in a worker and restricted VM. There is no module loader, `import`, `require`, filesystem API, or arbitrary host callback.

## Script shape

The script must declare a pure literal metadata object before its body:

```js
export const meta = {
  name: "audit-report",
  description: "Review selected files and produce a verified report",
  phases: [
    { title: "Audit" },
    { title: "Review" },
  ],
}

const reports = await pipeline(
  args.files,
  file => agent(`Review ${file} read-only.`, { phase: "Audit" }),
  (report, file) => agent(`Re-review ${file}: ${report}`, { phase: "Review" }),
)

return { reports: reports.filter(report => report !== null) }
```

`meta` must be a pure object literal. Variables, function calls, spreads, and template interpolation are rejected. Required fields are `name` and `description`; `phases` is optional and may contain `title`, `detail`, and display-only `model`.

The runtime input is available as `args`. It may be an object, array, scalar, or `undefined`. Tool-side JSON strings representing objects or arrays are normalized before entering the VM.

## Injected APIs

### `agent(prompt, options?)`

Runs one subagent and waits for its real result. It returns the final output string or `null` for a failed or skipped node. Use `parallel` or `pipeline` for concurrency.

Supported options:

- `label`: display name and the local continuation handle;
- `phase`: phase assignment;
- `agentType`: Profile ID or external runtime such as `herdr:agy`;
- `model`, `effort`: execution overrides;
- `isolation: "worktree"`: independent managed Git worktree;
- `cwd`: absolute target workspace;
- `gate`, `gateTimeoutMs`: verification command and timeout;
- `timeoutMs`: agent turn timeout;
- `resume`: continue an existing agent context by its local label;
- `schema`: JSON Schema for the result boundary;
- `attachments`: authorized artifact IDs;
- `maxSubagentDepth`: absolute task-tree depth cap;
- `maxAttempts`: bounded retry count for the agent node.

Do not combine `resume` with a new `agentType`, `model`, `isolation`, or `effort`. Continuations require an existing idle execution that still belongs to the current task tree.

### `agent.withMeta(prompt, options?)` and `goal(spec)`

These return execution metadata separately from the business output:

```js
const result = await agent.withMeta("Run the focused check.", {
  label: "focused-check",
  gate: "pnpm test:unit",
})
if (!result.ok) throw new Error(result.error ?? "agent failed")
return { output: result.output, execution: result.execution, gate: result.gate }
```

`goal({ objective, ...options })` uses the objective as the prompt and supports bounded in-place retries. A failed goal is not a successful partial result.

### `parallel(thunks)`

Runs thunks concurrently and returns results in input order. A failed branch becomes `null`; inspect the result before reporting completion.

```js
const results = await parallel([
  () => agent("Review the API boundary", { label: "api" }),
  () => agent("Review the persistence boundary", { label: "storage" }),
])
```

### `pipeline(items, ...stages)`

Runs every item through the stages in order. Stages for different items can run concurrently; stages for one item stay serial. A failed item becomes `null` without failing unrelated items.

### `action(actionId, input?, options?)`

Calls the host action bus with schema validation and produces a deterministic ledger node. Use a fully qualified ID such as `builtin:workflow.list` or an unambiguous short ID. Options include `idempotent`, `label`, and `phase`.

The built-in cross-node command action is:

```js
const check = await action("env.exec", {
  command: "git status --short",
  cwd: args.cwd,
  timeoutMs: 120000,
  allowFailure: true,
}, { idempotent: true, label: "git-status" })
```

Use the host action catalog or `run_action({ actionId, describe: true })` to inspect an action's full schema before calling it.

### `workflow(ref, args?)`

Runs a saved nested workflow by name, or a local reference such as `{ scriptPath: "/absolute/path/workflow.js" }`. Nested workflows share the root ledger and are checkpoint-replayable. The engine enforces a maximum nesting depth and total nested-call cap.

### `phase(title)`, `log(message)`, and `budget`

- `phase(title)` changes the current progress phase.
- `log(message)` emits progress text; it is not a business result.
- `budget.spent()` reports output bytes consumed. `budget.total` is `null` and `budget.remaining()` is `Infinity`; do not promise a token or cost budget from these values.

## Determinism and boundaries

- Do not use `Date.now()`, `Math.random()`, argument-less `new Date()`, `eval`, or `Function` constructors. Pass timestamps through `args` or add them after the workflow returns.
- Script values, action inputs/outputs, agent prompts/results, and final results must be JSON-serializable: no cycles, symbols, functions, BigInt, sparse arrays, non-finite numbers, or class instances.
- Every agent/action/workflow call must be awaited or returned. Unsettled calls at script completion are fatal.
- A gate failure, timeout, invalid schema, unavailable runtime, or uncertain side effect is an explicit failure. Never convert it into a successful summary.

## Running and replaying

- In a conversation, call `SubagentWorkflow` with exactly one of `script`, `scriptPath`, or `name`; pass `args` for runtime input.
- In a terminal, use `helmx workflows run <nameOrFile> --args <json> --current`; add `--wait` only when the CLI caller needs the terminal result.
- Use `resumeFromRunId` or `--resume-from-run-id` to replay the ledger. Matching completed nodes are reused; changed inputs, options, or non-idempotent side effects may invalidate reuse.
