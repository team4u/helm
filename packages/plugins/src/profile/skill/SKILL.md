---
name: {{SKILL_ID}}
description: Use when operating Helmx or querying host capabilities; covers conversations, models, nodes, plugin actions, triggers, and artifacts, with plugin-development topics on demand.
managedByPlugin: {{MANAGED_BY}}
---

# Helmx CLI Quick Reference

## Environment and CLI ground rules

1. The Helmx-managed `bash` provides the `helmx` CLI (PATH-first) and the session environment; usually you can call it directly without manual login:
   - `HELMX_ENV` (fixed to `1`, marking a Helmx-managed execution environment).
   - `HELMX_HUB_URL`: the Hub address; `HELMX_TOKEN`: the managed process token (never print it or write it into prompts). Troubleshoot by the actual error when a call fails.
   - `HELMX_CONVERSATION_ID`: the current conversation ID; `HELMX_CWD`: the session working directory; `HELMX_NODE_ID`: the bound node (with an extra `HELMX_DATA_DIR` when local).
   - `HELMX_EXECUTION_SCOPE`: a stable resource namespace for the current Helmx instance, conversation, node, and working directory. Repeated commands under the same execution coordinate reuse it; it changes after switching conversation, node, or working directory. When external tools support named sessions or resource isolation, you may name them explicitly with it. The variable does not configure external tools automatically, nor does it provide a process or file sandbox.
2. Always add `--json` when consuming output programmatically (human-readable output is for display only, not programmatic consumption).
3. Commands that support `--current` use it to select the current conversation (reads `HELMX_CONVERSATION_ID`); other commands take the target ID per their help.
4. Self-introspection first (do not memorize volatile details): query subcommand arguments live with `helmx --help`, `helmx <cmd> --help`; for dynamic plugin actions and their input JSON Schemas, trust the in-session `<available_actions>` catalog, read-only introspection via `run_action({ actionId, describe: true })`, or `helmx actions list --json`; for plugin config, use `helmx plugins config <id> --json`.
5. When the conversation is busy, `helmx send` supports `--when-busy steer|followUp|reject` (default steer when omitted); add `--wait` to wait for the reply.

## Core CLI command landscape (API and CLI on equal footing, all support --json)

### Auth and status
- `helmx status`: auth status (probing works even when unconfigured).
- `helmx setup --password <pwd>`: initialize the admin password and log in (first time only).
- `helmx login --password <pwd>`: log in and save credentials to cli-token.

### Local Hub maintenance
- `helmx start [-d] [--channel <tag>] [--port <n>] ...` starts the local Hub: installs the payload first when nothing is committed, then runs it in the foreground (Ctrl+C stops it via the verified control channel); `-d` runs detached in the background writing `hub.pid`. `helmx stop` stops gracefully (control channel first, pid identity proof fallback), `helmx restart` stops then starts detached. `helmx update --check [--channel <tag>] --json` checks the local Hub release and `helmx update` applies it (installs when nothing is committed). Run lifecycle commands from a local terminal or service manager outside any Helmx turn; foreground `helmx start` streams human-readable progress.

### Conversations
- `helmx conversations list [--profile <id>] [--status <s>] [--tag <t>]`: top-level conversations only by default (noise reduction); `--all` includes all derived sub-conversations such as subagents; `--parent <id>` lists exactly one conversation's direct children (mutually exclusive with --all).
- `helmx conversations get [id] [--current] [--limit N] [--cursor <c>]` (with a paginated timeline)
- `helmx conversations entry [id] <entryId> [--current]` (full text of a single timeline entry; detail pagination truncates head/tail of very long plain-text tool-results, and this command returns the untruncated original)
- `helmx conversations file [id] <path> [--current] [--output <path>]` (read a file strictly inside the conversation's bound workspace on the target node; text files are redacted via SecretStash, binary files require `--output`)
- `helmx conversations create [--title <t>] [--profile-id <id>] [--node <nodeId>] [--cwd <dir>] [--model <m>] [--tags <t>]`
- `helmx conversations update <id> --title/--model/--thinking/--profile-id/--node/--cwd/--pinned/--unread`
- `helmx conversations reset [id] [--current] [--handoff <text>]` (reset context; handoff becomes the first message)
- `helmx conversations compact [id] [--current]` / `helmx conversations fork [id] [--current] [--entry-id <n>] [--title <t>]` / `helmx conversations delete <id>`
- `helmx send <id> "<text>"` or `helmx send --current "<text>"`: submit input; supports `--wait`, `--when-busy steer|followUp|reject` (default steer when omitted), `--meta <json>`, `--attach <artifactIds>`, `--replace-from <entryId>` (resend overwriting from the given history entry, truncating that entry and everything after); use `--origin agent` when sending on an agent's behalf.
- `helmx ask "<text>"`: one-shot Q&A (internally creates a conversation and waits for the answer; stdout prints only the answer text by default, `--json` outputs `{conversationId,submissionId,entryId,answer,deleted}`); piped stdin content (non-TTY) merges into the prompt automatically; `--profile/--title/--cwd/--model/--tags/--timeout <ms>/--delete-on-success`; on failure the conversation is kept and the error envelope carries a queryable conversationId.
- `helmx conversations withdraw [id] [--current] --submission-id <n>`: withdraw a queued input (returns already_placed/settled honestly when execution started or it already settled).
- `helmx conversations watch <id> [--timeout <ms>] [--quiet]`: block until that conversation's current turn settles (done/idle -> exit 0, error -> exit 1, `--timeout` -> exit 124); live doing/status lines from the global SSE, `--quiet` prints only the final line, `--json` emits NDJSON progress plus a final `result` object — chain shell steps on the exit code. No `--current`, and never watch the conversation whose turn executes the command (circular wait): inside a managed turn, watching your own conversation id is rejected with `self_watch_forbidden` — watch subagents or other conversations by explicit id.
- `helmx abort [id] [--current]`: abort the current turn; never abort the turn you are currently executing.
- `helmx events watch`: subscribe to global SSE events (runs continuously; end with Ctrl+C).
- `helmx search <query>`: full-text search across the whole store (FTS5).

### Profiles and skills
- `helmx profiles list` / `helmx profiles get <id>`
- `helmx profiles create [id] --name/--model/--thinking/--node/--cwd/--system[-file]/--skills/--all-skills/--starters/--input <json>` (extension capabilities follow the current turn's plugin actions and skill catalog)
- `helmx profiles update <id> ...`: semantic flags GET-then-merge-PUT (bound fields are not lost); `--input` alone is a full replacement.
- `helmx profiles delete <id>` (the default assistant cannot be deleted).
- `helmx skills list` / `helmx skills read <id> [--path references/xxx.md]`. The built-in helmx-cli is a system-managed read-only skill, overwritten from built-in sources at startup; to extend it, create your own skill instead of modifying built-in files.

### Models and gateways
- `helmx models list` / `helmx models default [--set <provider/model>] [--thinking <level>] [--model-thinking <provider/model=level>] [--compaction <provider/model>] [--compaction-thinking <level>]` / `helmx models providers` / `helmx models refresh [--provider <id>]` / `helmx models filter [--provider <id> [--disable <modelId>... | --clear]]` (model disable set: view without arguments; full-replacement semantics; `--model-thinking` sets per-model thinking defaults — empty level like `provider/model=` clears that model's entry).
- `helmx providers list` / `helmx providers set --input <json>` (replaces the gateway array wholesale; secrets strictly forbidden).
- `helmx credentials list` / `helmx credentials set <id> --value <value>` / `helmx credentials delete <id>`: server-side credential management.

### Nodes and cross-machine execution
- `helmx nodes list`: nodes and online status; `helmx nodes issue <nodeId>`: issue a join token (the plaintext is returned exactly once); `helmx nodes remove <nodeId>`; `helmx nodes upgrade <nodeId> [--check]`: check or perform a node upgrade; `helmx nodes forward [<nodeId> | --current] <listenHost:listenPort> [<targetHost>:]<targetPort>`: foreground local TCP port forwarding (the event stream is the holder; Ctrl-C exits and closes); `helmx nodes forwards` / `helmx nodes forward-inspect <forwardId>` / `helmx nodes forward-stop <forwardId>`: active forward list/detail/stop.
- Remote machines join as nodes with a one-time npm install of the node daemon (`npm install -g @helmx/node`) followed by `helmx-node start -d --hub <url> --token <nodeId>:<secret>`; later versions arrive via `helmx nodes upgrade` (the daemon upgrades the `@helmx/node` npm artifact).
- `helmx env exec [--node <id>] [--cwd <dir>] [--timeout <ms>] [--stream] [--current] -- <command...>`: execute a command directly across nodes; the timeout unit is milliseconds.

### Plugins and actions
- `helmx plugins list` (incl. status: active|disabled|failed with failure diagnostics) / `helmx plugins enable <id>` / `helmx plugins disable <id> [--force]` (when the occupancy precheck returns 409 plugin_in_use, `--force` can force it; in-flight running tasks still cannot be skipped) / `helmx plugins config <id> [--input <json>] [--set k=v] [--unset <key>]` (`--unset` sends null to remove an explicit override; repeatable; conflicts with `--set` on the same key error out) / `helmx plugins client <id>`.
- `helmx plugins doctor <id|dir>`: static self-check of external plugin source (real-generation imports + real registration assertions + real client compilation and dangling-export validation); pick one target: an absolute directory path or a registered plugin id; failed precheck items are listed one by one, never silently.
- `helmx plugins reload <id>`: controlled hot-reload of an external plugin (doctor precheck first; on failure the old instance stays untouched; in-flight tasks reject with 409; enablement state is kept).
- `helmx plugins rescan`: incrementally rescan the plugins directory (registers only new external plugins, disabled by default).
- `helmx plugins init [name] [--dir <parent-dir>] [--template minimal|full] [--force]`: scaffold an external plugin skeleton locally (full by default: plugin.json + index.ts + tsconfig.json + client/index.tsx; minimal is backend-only); touches no Hub.
- `helmx plugins build [dir] [--out <dir>]`: precompile a plugin directory's frontend modules into static `dist-client/` artifacts locally (zero runtime esbuild / npm dependency install required on target hosts); touches no Hub.
- Plugin source/runtime modes are separate from enablement and reload. For the distinction between Hub source development, built-in package builds, external plugin backend loading, runtime client compilation, and prebuilt `dist-client` artifacts, read `references/skill-and-plugin-dev.md` before choosing a build or verification command.
- `helmx plugins install <source> [--enable]`: install an external plugin package from `npm:<spec>`, `git:<repo>@<ref>`, an HTTPS Git URL, or a local path and register it (disabled by default; `--enable` enables right after install). The source is resolved and fetched by the Hub server (a local path is a path on the Hub host, not a client upload); installing and enabling executes trusted plugin code inside the Hub process, with no sandbox.
- `helmx plugins update <id>`: update a managed installed external plugin package and reload it (returns changed:false honestly when the source is unchanged).
- `helmx plugins remove <id> [--yes]`: remove a managed installed external plugin package (destructive: disables and cleans the installation directory and records on the Hub host). Human-mode TTY requires typing yes; use `--yes` in non-interactive environments; `--json` is non-interactive.
- `helmx plugins doc <id> <name>`: read a global public doc; add `--conversation <n>` (or `--current`) for session docs, and `--watch` for continuous subscription (a dedicated SSE whose first frame is the current value; Ctrl-C exits).
- Action discovery defers to the current turn's catalog and tool list: the system prompt's `<available_actions>` section lists plugin actions that are currently enabled, match this conversation's scope, and are invoked via `run_action`; directly exposed actions appear in the model tool list. Built-in and external plugins are equal; new plugins appear automatically without touching SYSTEM.md or built-in skills. Each catalog entry carries the fully-qualified ID (`pluginId.actionId`), description, available CLI command, and a compact parameter signature, plus optional author-declared guidance; entries disappear automatically when a plugin is disabled or an action is unreachable.
- The catalog is a summary, not the full contract: before calling, prefer `run_action({ actionId: "<pluginId>.<actionId>", describe: true })` to read the action's complete manifest (incl. nested input/output JSON Schemas) without executing the handler or side effects; describe is also filtered by enablement and scope, so sessions without bash can still introspect. With bash you can also use `helmx actions list --json` (full catalog) or `helmx <plugin> <action> --help` (single-action arguments).
- `run_action({ actionId, input })` can call catalog actions directly without reading this skill first; actions with `exposeAsTool: true` additionally appear in the tool list as standalone tools with equivalent calling semantics.
- `helmx <plugin> <action>`: actions map automatically to top-level CLI commands (stripping the `builtin:` prefix; `cli.command` can override; e.g. `helmx my-plugin send_notice`), with `--input <json>` for parameters.

### Approvals, artifacts, and the escape hatch
- `helmx asks list` / `helmx asks answer <id> --answers <json> [--expected-state-seq <n>]` (CAS optimistic lock) / `helmx asks cancel <id>`.
- `helmx artifacts list [id] [--current]` / `helmx artifacts put <filePath> [id] [--name <n>] [--mime-type <m>]` / `helmx artifacts get <id> [--output <path>]`.
- When generating text files for the user to view in the Web, use `write(..., artifact: true)`. To register an existing file (incl. images, videos, PDFs), use `register_artifact({ path: "<path>" })`: the path resolves relative to the current conversation's cwd, is read on the conversation's bound node, and is copied into the Hub's artifact directory; delivery counts as successful only after the artifact ID returns. Single artifacts are capped at 15 MiB.
- In a terminal, use `helmx artifacts put <path> --current` to upload a local file on the calling machine; relative paths resolve against that CLI process's actual cwd -- `--current` only selects the conversation and never changes where files are read from. `helmx artifacts get <id> --output <path>` likewise writes on the calling machine and echoes the actual absolute path on success. Never treat a Hub or another node's path as a local path.
- When an external command generates a file to deliver, use a filename or directory unique to this task and pass an absolute output path based on the actual execution directory; in a POSIX shell you can do `output="$PWD/report-<task-identifier>.png"` first. When explicitly choosing another directory, confirm it exists on the actual execution node. `HELMX_CWD` is the managed session directory; after `cd` in a shell, `$PWD` may differ from it.
- After generation, confirm the expected file exists, then register it with the same absolute path; a zero exit code or "saved successfully" output is no substitute for artifact registration. On read failure, investigate by the absolute path and node in the error; never auto-search other sessions' worktrees or mistake an old same-name file for this task's artifact.
- Artifact registration stores an independent copy; files to deliver must be registered before cleaning the source worktree. After success, inline-render them in the reply with `[filename](artifact:<id>)` or `![image](artifact:<id>)`. Cleaning the worktree does not delete these copies; deleting the owning conversation cascades to its artifacts.
- `helmx api <METHOD> <path> [--input <json>] [--field k=v]`: raw HTTP escape hatch (e.g. `helmx api GET /api/nodes`).

## Topic manuals on demand

When a matching topic comes up, read the reference file before acting:
- Before bootstrapping a new skill (~/.helmx/skills/<id>/SKILL.md) or developing an external plugin (~/.helmx/plugins/<id>/):
  `load_skill({ skillId: "helmx-cli", path: "references/skill-and-plugin-dev.md" })`.
- Before developing or optimizing a plugin's client.tsx, especially involving heavy dependencies, dynamic imports, first-load performance, or async chunks:
  `load_skill({ skillId: "helmx-cli", path: "references/plugin-client-code-splitting.md" })`.
- Interactive displays, micro-app building, and other extension capabilities: choose per the current turn's available skill descriptions -- load the applicable skill first, then follow its guidance to call tools or actions from `<available_actions>`; with no applicable skill, use plain Markdown and never reference manuals outside the catalog.
