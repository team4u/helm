---
name: {{SKILL_ID}}
description: Use when operating Helm or querying host capabilities; covers conversations, models, nodes, plugin actions, triggers, and artifacts, with workflow and plugin-development topics on demand.
managedByPlugin: {{MANAGED_BY}}
---

# Helm CLI Quick Reference

## Environment and CLI ground rules

1. The Helm-managed `bash` provides the `helm` CLI (PATH-first) and the session environment; usually you can call it directly without manual login:
   - `HELM_ENV` (fixed to `1`, marking a Helm-managed execution environment).
   - `HELM_HUB_URL`: the Hub address; `HELM_TOKEN`: the managed process token (never print it or write it into prompts). Troubleshoot by the actual error when a call fails.
   - `HELM_CONVERSATION_ID`: the current conversation ID; `HELM_CWD`: the session working directory; `HELM_NODE_ID`: the bound node (with an extra `HELM_DATA_DIR` when local).
   - `HELM_EXECUTION_SCOPE`: a stable resource namespace for the current Helm instance, conversation, node, and working directory. Repeated commands under the same execution coordinate reuse it; it changes after switching conversation, node, or working directory. When external tools support named sessions or resource isolation, you may name them explicitly with it. The variable does not configure external tools automatically, nor does it provide a process or file sandbox.
2. Always add `--json` when consuming output programmatically (human-readable output is for display only, not programmatic consumption).
3. Commands that support `--current` use it to select the current conversation (reads `HELM_CONVERSATION_ID`); other commands take the target ID per their help.
4. Self-introspection first (do not memorize volatile details): query subcommand arguments live with `helm --help`, `helm <cmd> --help`; for dynamic plugin actions and their input JSON Schemas, trust the in-session `<available_actions>` catalog, read-only introspection via `run_action({ actionId, describe: true })`, or `helm actions list --json`; for plugin config, use `helm plugins config <id> --json`.
5. When the conversation is busy, `helm send` supports `--when-busy steer|followUp|reject` (default steer when omitted); add `--wait` to wait for the reply.

## Core CLI command landscape (API and CLI on equal footing, all support --json)

### Auth and status
- `helm status`: auth status (probing works even when unconfigured).
- `helm setup --password <pwd>`: initialize the admin password and log in (first time only).
- `helm login --password <pwd>`: log in and save credentials to cli-token.

### Conversations
- `helm conversations list [--profile <id>] [--status <s>] [--tag <t>]`: top-level conversations only by default (noise reduction); `--all` includes all derived sub-conversations such as subagents; `--parent <id>` lists exactly one conversation's direct children (mutually exclusive with --all).
- `helm conversations get [id] [--current] [--limit N] [--cursor <c>]` (with a paginated timeline)
- `helm conversations entry [id] <entryId> [--current]` (full text of a single timeline entry; detail pagination truncates head/tail of very long plain-text tool-results, and this command returns the untruncated original)
- `helm conversations create [--title <t>] [--profile-id <id>] [--node <nodeId>] [--cwd <dir>] [--model <m>] [--tags <t>]`
- `helm conversations update <id> --title/--model/--thinking/--profile-id/--node/--cwd/--pinned/--unread`
- `helm conversations reset [id] [--current] [--handoff <text>]` (reset context; handoff becomes the first message)
- `helm conversations compact [id] [--current]` / `helm conversations fork <id> --entry-id <n> [--title <t>]` / `helm conversations delete <id>`
- `helm send <id> "<text>"` or `helm send --current "<text>"`: submit input; supports `--wait`, `--when-busy steer|followUp|reject` (default steer when omitted), `--meta <json>`, `--attach <artifactIds>`, `--replace-from <entryId>` (resend overwriting from the given history entry, truncating that entry and everything after); use `--origin agent` when sending on an agent's behalf.
- `helm ask "<text>"`: one-shot Q&A (internally creates a conversation and waits for the answer; stdout prints only the answer text by default, `--json` outputs `{conversationId,submissionId,entryId,answer,deleted}`); piped stdin content (non-TTY) merges into the prompt automatically; `--profile/--title/--cwd/--model/--tags/--timeout <ms>/--delete-on-success`; on failure the conversation is kept and the error envelope carries a queryable conversationId.
- `helm conversations withdraw [id] [--current] --submission-id <n>`: withdraw a queued input (returns already_placed/settled honestly when execution started or it already settled).
- `helm abort [id] [--current]`: abort the current turn; never abort the turn you are currently executing.
- `helm events watch`: subscribe to global SSE events (runs continuously; end with Ctrl+C).
- `helm search <query>`: full-text search across the whole store (FTS5).

### Profiles and skills
- `helm profiles list` / `helm profiles get <id>`
- `helm profiles create [id] --name/--model/--thinking/--node/--cwd/--system[-file]/--skills/--all-skills/--starters/--input <json>` (extension capabilities follow the current turn's plugin actions and skill catalog)
- `helm profiles update <id> ...`: semantic flags GET-then-merge-PUT (bound fields are not lost); `--input` alone is a full replacement.
- `helm profiles delete <id>` (the default assistant cannot be deleted).
- `helm skills list` / `helm skills read <id> [--path references/xxx.md]`. The built-in helm-cli is a system-managed read-only skill, overwritten from built-in sources at startup; to extend it, create your own skill instead of modifying built-in files.

### Models and gateways
- `helm models list` / `helm models default [--set <provider/model>] [--thinking <level>]` / `helm models providers` / `helm models refresh [--provider <id>]` / `helm models filter [--provider <id> [--disable <modelId>... | --clear]]` (model disable set: view without arguments; full-replacement semantics).
- `helm providers list` / `helm providers set --input <json>` (replaces the gateway array wholesale; secrets strictly forbidden).
- `helm credentials list` / `helm credentials set <id> --value <value>` / `helm credentials delete <id>`: server-side credential management.

### Nodes and cross-machine execution
- `helm nodes list`: nodes and online status; `helm nodes issue <nodeId>`: issue a join token (the plaintext is returned exactly once); `helm nodes remove <nodeId>`; `helm nodes upgrade <nodeId> [--check]`: check or perform a node upgrade; `helm nodes forward [<nodeId> | --current] <listenHost:listenPort> [<targetHost>:]<targetPort>`: foreground local TCP port forwarding (the event stream is the holder; Ctrl-C exits and closes); `helm nodes forwards` / `helm nodes forward-inspect <forwardId>` / `helm nodes forward-stop <forwardId>`: active forward list/detail/stop.
- `helm env exec [--node <id>] [--cwd <dir>] [--timeout <ms>] [--stream] [--current] -- <command...>`: execute a command directly across nodes; the timeout unit is milliseconds.
- `helm worktrees list`: list managed worktree registrations (incl. metadata of cleaned records); `helm worktrees inspect <worktreeId>`: read-only inspection (registration metadata + the target node's real git status/stats/capped diff preview; `--conversation-id <id>` / `--path <path> [--node-id <nodeId>]` can replace the selector, `--diff=false` omits the diff body); `helm worktrees cleanup [--worktree-id <id> | --conversation-id <id> | --current | --path <path> [--node-id <nodeId>]] [--delete-branch] [--merged-into <ref>] [--force]`: clean up a managed worktree; by default it refuses dirty workspaces, unmerged commits, and in-use/unconfirmed-stopped executions. Unmerged-check baseline: an explicit `--merged-into` names the merged target branch or commit (a 400 error when absent, no fallback); the default is the registered parent branch `baseBranch`; then it falls back to the main worktree HEAD. When a child branch is merged into the parent module branch but the parent is not yet merged into main, pass `--merged-into <parent-branch>` to clean up normally without `--force`.

### Workflows
- `helm workflows list` / `helm workflows get <name>` / `helm workflows save [nameOrFile] [--from-run-id <id>] [--name <n>] [--overwrite]` / `helm workflows delete <name>` / `helm workflows run <nameOrFile> [--args <json>] [--resume-from-run-id <id>] [--current] [--wait]` / `helm workflows runs` / `helm workflows inspect <runId>` / `helm workflows abort <runId>` / `helm workflows detach <runId>` (move a foreground synchronous run to the background: the blocked call immediately receives a background handle, with a follow-up report at the terminal state) / `helm workflows steer <runId> --text <guidance>` / `helm workflows resume-failed [--conversation-id <id> | --current | --all]` (batch-resume recoverable failed workflows and background subagents, recording unrecoverable items in `skipped`). Workflow definitions are cross-conversation assets (the single source of truth is the data directory's `workflows/<name>.js`): `save` takes a local script file or target name as its positional argument, runs an automatic syntax precheck before saving, refuses duplicates by default, and only overwrites with `--overwrite`; `delete` removes only the definition file, leaving historical run records untouched. `steer` interjects guidance into a running background subagent: native nodes submit under ownership and CAS-watermark guards; external executions (e.g. Herdr with atomic guard capability) delegate to the target plugin via the node control reference; DSL workflows, human ownership, or already-advanced facts are rejected; a successful steer send does not mean the guidance has been executed. `workflows run --resume-from-run-id <runId>` replays from the checkpoint (and also supports failed/aborted background subagents that carry a resumable handle): completed agent/action ledger entries reuse their results directly (zero tokens), and the run continues live from the breakpoint; it reuses the original run's conversation and args (explicitly overridable), and refuses when the original run is still running or the ledger contains uncertain side effects. Failed background runs are auto-resumed by the Watchdog per its cooldown policy (at most 3 times); before a manual resume, check the state with `helm workflows inspect <runId>` and do not double-trigger with the automatic resume.

### Plugins and actions
- `helm plugins list` (incl. status: active|disabled|failed with failure diagnostics) / `helm plugins enable <id>` / `helm plugins disable <id> [--force]` (when the occupancy precheck returns 409 plugin_in_use, `--force` can force it; in-flight running tasks still cannot be skipped) / `helm plugins config <id> [--input <json>] [--set k=v] [--unset <key>]` (`--unset` sends null to remove an explicit override; repeatable; conflicts with `--set` on the same key error out) / `helm plugins client <id>`.
- `helm plugins doctor <id|dir>`: static self-check of external plugin source (real-generation imports + real registration assertions + real client compilation and dangling-export validation); pick one target: an absolute directory path or a registered plugin id; failed precheck items are listed one by one, never silently.
- `helm plugins reload <id>`: controlled hot-reload of an external plugin (doctor precheck first; on failure the old instance stays untouched; in-flight tasks reject with 409; enablement state is kept).
- `helm plugins rescan`: incrementally rescan the plugins directory (registers only new external plugins, disabled by default).
- `helm plugins init [name] [--dir <parent-dir>] [--template minimal|full] [--force]`: scaffold an external plugin skeleton locally (full by default: plugin.json + index.ts + tsconfig.json + client/index.tsx; minimal is backend-only); touches no Hub.
- `helm plugins install <source> [--enable]`: install an external plugin package from `npm:<spec>`, `git:<repo>@<ref>`, an HTTPS Git URL, or a local path and register it (disabled by default; `--enable` enables right after install). The source is resolved and fetched by the Hub server (a local path is a path on the Hub host, not a client upload); installing and enabling executes trusted plugin code inside the Hub process, with no sandbox.
- `helm plugins update <id>`: update a managed installed external plugin package and reload it (returns changed:false honestly when the source is unchanged).
- `helm plugins remove <id> [--yes]`: remove a managed installed external plugin package (destructive: disables and cleans the installation directory and records on the Hub host). Human-mode TTY requires typing yes; use `--yes` in non-interactive environments; `--json` is non-interactive.
- `helm plugins doc <id> <name>`: read a global public doc; add `--conversation <n>` (or `--current`) for session docs, and `--watch` for continuous subscription (a dedicated SSE whose first frame is the current value; Ctrl-C exits).
- Action discovery defers to the current turn's catalog and tool list: the system prompt's `<available_actions>` section lists plugin actions that are currently enabled, match this conversation's scope, and are invoked via `run_action`; directly exposed actions appear in the model tool list. Built-in and external plugins are equal; new plugins appear automatically without touching SYSTEM.md or built-in skills. Each catalog entry carries the fully-qualified ID (`pluginId.actionId`), description, available CLI command, and a compact parameter signature, plus optional author-declared guidance; entries disappear automatically when a plugin is disabled or an action is unreachable.
- The catalog is a summary, not the full contract: before calling, prefer `run_action({ actionId: "<pluginId>.<actionId>", describe: true })` to read the action's complete manifest (incl. nested input/output JSON Schemas) without executing the handler or side effects; describe is also filtered by enablement and scope, so sessions without bash can still introspect. With bash you can also use `helm actions list --json` (full catalog) or `helm <plugin> <action> --help` (single-action arguments).
- `run_action({ actionId, input })` can call catalog actions directly without reading this skill first; actions with `exposeAsTool: true` additionally appear in the tool list as standalone tools with equivalent calling semantics.
- `helm <plugin> <action>`: actions map automatically to top-level CLI commands (stripping the `builtin:` prefix; `cli.command` can override; e.g. `helm my-plugin send_notice`), with `--input <json>` for parameters.

### Approvals, artifacts, and the escape hatch
- `helm asks list` / `helm asks answer <id> --answers <json> [--expected-state-seq <n>]` (CAS optimistic lock) / `helm asks cancel <id>`.
- `helm artifacts list [id] [--current]` / `helm artifacts put <filePath> [id] [--name <n>] [--mime-type <m>]` / `helm artifacts get <id> [--output <path>]`.
- When generating text files for the user to view in the Web, use `write(..., artifact: true)`. To register an existing file (incl. images, videos, PDFs), use `register_artifact({ path: "<path>" })`: the path resolves relative to the current conversation's cwd, is read on the conversation's bound node, and is copied into the Hub's artifact directory; delivery counts as successful only after the artifact ID returns. Single artifacts are capped at 15 MiB.
- In a terminal, use `helm artifacts put <path> --current` to upload a local file on the calling machine; relative paths resolve against that CLI process's actual cwd -- `--current` only selects the conversation and never changes where files are read from. `helm artifacts get <id> --output <path>` likewise writes on the calling machine and echoes the actual absolute path on success. Never treat a Hub or another node's path as a local path.
- When an external command generates a file to deliver, use a filename or directory unique to this task and pass an absolute output path based on the actual execution directory; in a POSIX shell you can do `output="$PWD/report-<task-identifier>.png"` first. When explicitly choosing another directory, confirm it exists on the actual execution node. `HELM_CWD` is the managed session directory; after `cd` in a shell, `$PWD` may differ from it.
- After generation, confirm the expected file exists, then register it with the same absolute path; a zero exit code or "saved successfully" output is no substitute for artifact registration. On read failure, investigate by the absolute path and node in the error; never auto-search other sessions' worktrees or mistake an old same-name file for this task's artifact.
- Artifact registration stores an independent copy; files to deliver must be registered before cleaning the source worktree. After success, inline-render them in the reply with `[filename](artifact:<id>)` or `![image](artifact:<id>)`. Cleaning the worktree does not delete these copies; deleting the owning conversation cascades to its artifacts.
- `helm api <METHOD> <path> [--input <json>] [--field k=v]`: raw HTTP escape hatch (e.g. `helm api GET /api/nodes`).

## Topic manuals on demand

When a matching topic comes up, read the reference file before acting:

- Before orchestrating multi-agent/multi-stage tasks (subagent, SubagentWorkflow deterministic scripts) or collaborating with Herdr terminal agents or SuperAgent Workers:
  `load_skill({ skillId: "helm-cli", path: "references/workflows-and-agents.md" })`.
- Before bootstrapping a new skill (~/.helm/skills/<id>/SKILL.md) or developing an external plugin (~/.helm/plugins/<id>/):
  `load_skill({ skillId: "helm-cli", path: "references/skill-and-plugin-dev.md" })`.
- Before developing or optimizing a plugin's client.tsx, especially involving heavy dependencies, dynamic imports, first-load performance, or async chunks:
  `load_skill({ skillId: "helm-cli", path: "references/plugin-client-code-splitting.md" })`.
- Interactive displays, micro-app building, and other extension capabilities: choose per the current turn's available skill descriptions -- load the applicable skill first, then follow its guidance to call tools or actions from `<available_actions>`; with no applicable skill, use plain Markdown and never reference manuals outside the catalog.
