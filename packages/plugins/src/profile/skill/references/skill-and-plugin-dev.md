# Skill and Plugin Bootstrap Development Reference

## Bootstrapping skills (~/.helm/skills/<id>/)

Skills are operation manuals the model loads on demand; keep SKILL.md short and put details in references/. All paths below live under the Hub data directory; when HELM_DATA_DIR is configured, use that directory. Bash running on a remote node must not treat the local ~/.helm as the Hub's asset directory.

```
~/.helm/skills/deploy-playbook/
  SKILL.md              # required: frontmatter + index-level body
  references/
    rollback.md         # on-demand drill-down files (nested subdirs allowed)
    db-migrate.md
```

SKILL.md skeleton:

```markdown
---
name: deploy-playbook
description: Release process playbook (the model decides when to load by this sentence)
---

# Release Process

Read the reference files first when a scenario matches:

- references/rollback.md: rollback steps
- references/db-migrate.md: database migration
```

Key points:
- The id directory name must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}; paths inside references forbid absolute paths/`..`/backslashes/symlinks (strictly validated).
- The description decides triggering -- write it concretely and scenario-specific; keep details out of the body, let the index point the way.
- After writing, verify recognition with `helm skills list` and readability with `helm skills read <id>`.

## Developing external plugins (~/.helm/plugins/<dir>/)

Prefer `helm plugins init <name>` to generate the full skeleton (incl. `plugin.json`, `index.ts`, `client/index.tsx`); you can also hand-place a `plugin.json` declaring `{ "id": "my-plugin", "main": "index.ts", "clientRoot": "./client" }` or a conventional entry (`index.ts` / `index.mjs` / `index.js`).

The server entry directly exports an object satisfying PluginDefinition, where definePlugin(ctx) registers capabilities; TypeScript works directly (the host transpiles and loads along the dependency closure):

```ts
// ~/.helm/plugins/my-plugin/index.ts
export default {
  id: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  clientRoot: "./client", // required when frontend components live in client/ (default root is the plugin directory itself)
  definePlugin(ctx) {
    const state = ctx.doc("state", { count: 0 }, { public: true })
    ctx.action({
      id: "increment",
      description: "Increment the counter by one",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"], additionalProperties: false },
      handler() {
        state.update(current => ({ count: current.count + 1 }))
        return state.get()
      },
    })
    ctx.ui.sidebarItem({ id: "my", label: "My Plugin", icon: "terminal", target: "screen:my-plugin/main" })
    // client.module resolves relative to clientRoot (here: <plugin dir>/client/index.tsx)
    ctx.ui.screen({
      id: "main", label: "Counter",
      client: { module: "index.tsx", export: "CounterScreen" },
    })
  },
}
```

client/index.tsx (shares the host React and SDK; never bundles a second React):

```tsx
import { usePluginContext, usePluginDoc } from '@helm/plugin-client'

export function CounterScreen() {
  const { callAction } = usePluginContext()
  const state = usePluginDoc<{ count: number }>('state')
  return (
    <div className="card">
      <div>Count: {state?.count ?? 0}</div>
      <button type="button" className="btn btn-primary" onClick={() => void callAction('increment', {})}>+1</button>
    </div>
  )
}
```

Controlled frontend npm dependencies and plugin dependencies:

- client.tsx allows only `react`, `react-dom`, `lucide-react`, `@helm/plugin-client`, and relative imports inside the plugin directory by default; third-party bare npm packages must be declared explicitly.
- Frontend dependencies can live in `plugin.json`:

```json
{
  "clientRoot": "./client",
  "clientDependencies": ["dayjs", "katex"]
}
```

  or in `package.json` under `helm.clientDependencies`:

```json
{
  "dependencies": { "dayjs": "^1.11.0" },
  "helm": { "clientDependencies": ["dayjs", "katex"] }
}
```

- `clientDependencies` is an exact bare-specifier whitelist for the frontend bundle; subpaths (e.g. `lodash/map`) must also be declared individually. The resolution root is pinned to the plugin's own directory; external plugin code cannot customize `npmDependencies` resolution roots.
- For managed installs, `helm plugins install` / `helm plugins update` install declared frontend dependencies with `--no-save`; also writing the package and version range into `package.json.dependencies` is recommended so installs stay reproducible. Bare package names without version ranges install per the package manager's current resolution.
- `helm plugins doctor <dir>`, `helm apps validate <dir>`, and runtime client compilation share the same dependency boundary; missing dependencies, undeclared bare imports, and out-of-root relative paths fail explicitly -- never fake a pass with plain Markdown or empty components.
- Inter-plugin dependencies can be declared in `plugin.json.dependencies` or `package.json.helm.dependencies`, e.g. `["base-plugin"]`; or in the entry export object's `dependencies` field (the three merge and dedup). It accepts plugin IDs only, not npm version ranges. Before enabling, depended-on plugins must be registered and enabled; dependency cycles are rejected; others disabling/uninstalling a plugin you depend on is blocked by `plugin_in_use`.
- A dependency declaration is not a calling mechanism; it only provides guarantees (the dependency exists, starts first, and cannot be pulled away). To actually invoke another plugin's features, use `ctx.host.invokeAction`:

```ts
// Depender: after declaring dependencies, safely call the other's actions at service start
export default {
  id: 'my-plugin',
  dependencies: ['base-plugin'],
  definePlugin(ctx) {
    ctx.service({
      id: 'worker',
      async start() {
        const result = await ctx.host.invokeAction(
          'base-plugin', 'analyze', { text: 'hello' },
        ) as { score: number }
        // The call passes the defense line: the target must be enabled (disabled errors
        // explicitly, never a silent empty return); input is validated by the target's
        // inputSchema, output by its outputSchema, uniformly redacted.
      },
      async stop() {},
    })
  },
}
```

- Dynamic discovery: `ctx.host.listActions()` returns all enabled plugins' action catalogs (pluginId / id / inputSchema / outputSchema / idempotent) for on-demand invocation; before calling, `ctx.host.prepareAction(pluginId, actionId, input)` does a side-effect-free precheck.
- Async communication goes through the event bus: publish with `await ctx.host.emitEvent('my-plugin:done', payload)` (others subscribe via `ctx.host.onEvent`); `onEvent` returns an unsubscribe function, and the host auto-unsubscribes on plugin disable.
- UI composition uses `ctx.ui.slot` to inject components into other plugins' named slots; on the frontend, read other plugins' public docs with `usePluginDoc(name, pluginId)` and invoke cross-plugin actions with `callAction(actionId, input, { pluginId })`.
- Never import another plugin's code directly: plugins are independent module graphs (supporting generational hot reload), and direct imports would weld two plugins' lifecycles together; cross-plugin interaction always goes through the interface-oriented channels invokeAction / events / slots.

Extension entries:
- Backend hooks ({{HOOK_COUNT}}): {{HOOK_NAMES}}; each hook's allowed continue/transform/handled/block results follow the protocol contract.
- Frontend {{UI_METHOD_COUNT}} ctx.ui registration methods: the base 10 (sidebarItem/sidebarSection, screen, timelineRenderer, markdownCodeBlock, toolView, composerPill/composerWidget, workbenchPanel, command, settingsPanel) + the unified UI action `action` (target one of conversation:header / conversation:row / timeline:entry; once bound to an actionId the host manages the button/pending/failure hints, scope filters conversations by tag, timeline:entry filters message entries by kinds/roles; the host-injected real conversationId/entryId forcibly override same-named input fields) + profileRuntime (Profile external-runtime metadata) + slot (plugin child slots) + artifactPreviewer (preview artifacts by MIME/suffix) + composerCompleter (input reference completion sources).
- timelineRenderer/markdownCodeBlock/toolView/artifactPreviewer/composerCompleter support priority (adjudicated in descending order, default 0; ties keep contribution order); one plugin may declare multiple settings.panel blocks (ordered by `order`). markdownCodeBlock takes over Markdown code-block rendering by fence language (`languages`); without a registration hit it falls back to a plain code block.
- `Profile.starters` are statically configured blank-conversation prompts, not a UI extension point; at most six per Profile, label at most 24 Unicode code points, prompt at most 4000 code points. They show only in a genuinely empty conversation with history fully loaded; clicking backfills the draft without sending; existing drafts, attachments, edits, or in-flight operations are never overwritten. CLI: `helm profiles update <id> --starters '<json array>' --json`, pass `[]` to clear.
- A command's slash (trigger word without /) also derives an input-box `/` completion: reserved words {{RESERVED_SLASH_COMMANDS}} and the skill: prefix are unclaimable, names must not collide across enabled plugins, and declaring slash requires binding to this plugin's actionId (use actionPluginId for cross-plugin actions).
- screen components receive params/setParams: in the URL hash, main-screen `sp.<key>` and split-screen `ssp.<key>` namespaces stay isolated, so two instances of the same screen never interfere; setParams replaces by default, `{push:true}` pushes onto the stack; components must not build their own routing or touch history directly.
- composer.pill/widget receive the controlled handle composer (draft/attachments/sending, setDraft/insertText/submit; a failing submit() rejects and keeps the draft).
- `composerCompleter` declares pure-data completion sources for `@ / # :` (`/` is reserved for commands/skills): `source` must explicitly pick `{kind:'action', actionId, actionPluginId?}` or `{kind:'doc'|'sessionDoc', name, itemsField}`. Action input `{query, conversationId?, profileId?}` (real conversations pass `conversationId`; standby-draft mode passes `profileId` or just `{query}` per the schema), output `{items:[{id,label,insertText,hint?,icon?}]}`, and must be `idempotent: true`; doc sources must be a top-level array field of this plugin's own public doc/sessionDoc -- never guess `docs[0]`. Completion replaces only the trigger token and inserts text only; it never submits/executes. The Web debounces queries; CLI/Agent/Workflow go through the same Action.
- `artifactPreviewer` matches by MIME (exact value or `type/*`) and/or lowercase extension (e.g. `.csv`, `.topo.json`); declare at least one kind; MIME and extension OR together, adjudicated by scope and priority. The component receives the host-managed `blobUrl`, optional metadata name, and at most 1 MiB of text; users can still switch back to the default preview and download. The client remains trusted code, not a sandbox; when displaying untrusted HTML, put it in a default permission-less `<iframe sandbox="">`, never inject it into the host DOM, and never claim `allow-scripts` is risk-free.
- `NODE_DETAIL_SECTION_SLOT` (`builtin:node/detail-section`) is a host-reserved slot in the node center, not a `builtin:node` plugin. Use `ctx.ui.slot` to inject into the existing-node extension area, Props being `{nodeId,isLocal,isOnline,isNew:false}`; pass no tokens/join commands, and do not mount on the new-node join form.
- `ctx.action({ id, description, inputSchema, outputSchema, cli?, exposeAsTool?, idempotent?, scope?, promptSnippet?, promptGuidelines?, handler })` uniformly maps a Schema action onto HTTP, CLI, Workflow action(), the Web, and the conversation action catalog: enabled actions matching the conversation's scope that are not directly exposed as tools automatically appear in the system prompt's `<available_actions>` catalog (fully-qualified ID/description/CLI command/compact signature; built-in and external plugins are equal; new plugins need no SYSTEM.md or built-in-skill changes); the model calls them directly via `run_action({ actionId, input })`, and `run_action({ actionId, describe: true })` read-only returns the full manifest (incl. nested schemas, without executing the handler, likewise filtered by enablement and scope). `exposeAsTool: true` derives a standalone model tool not duplicated in the catalog; `ctx.tool` is a dedicated tool visible only to the model and outside the five-end mapping; both support `promptSnippet` (a full paragraph) / `promptGuidelines` (a bullet list): guidance injects only when actually activated, without duplicating the catalog; on disable or unreachable scope, the catalog, tools, and prompt fragments are cleaned automatically, leaving no phantoms. `idempotent: true` marks read-only/idempotent actions, allowing workflows to rerun them across broken chains after failure or interruption.
- `ctx.host.execEnv(req, opts?)` executes commands across nodes via the kernel EnvFabric (reusing local / remote @helm/node channels, SecretStash injection, and redaction), tracked as in-flight tasks (withTask).
- `ctx.host.forkConversation(id, { entryId?, title? })` hot-forks a new conversation from a specified visible entry or, when `entryId` is omitted, from the latest clean anchor of the source conversation (automatically skipping trailing unclosed `toolCall`s; same source as `POST /api/conversations/:id/fork`, tracked as in-flight; a missing source conversation or entry throws 404, an invalid `entryId` 400, and empty completed non-system history 409 `fork_empty_history`). To derive a native sub-conversation from the parent conversation's currently completed history through the `agent_spawn` pipeline, pass `ctx.host.spawnAgent({ ..., fork: true })` (automatically avoiding unclosed toolCalls; native Profiles only -- external runtimes reject explicitly).
- `ctx.host.nodeFetch(nodeId): typeof fetch` / `ctx.host.openTunnel(nodeId, { host?, port }, signal?)` access HTTP(S)/SSE services from the target node's perspective, or obtain an arbitrary TCP duplex stream, via EnvFabric node tunnels (the node resolves host, defaulting to `127.0.0.1`; active tunnels are tracked as in-flight). No companion plugin code is needed on the node side.
- `ctx.doc(name, initial, { public: true, durable? })` exposes global state (enters the global SSE first frame; updates broadcast in full; pass `durable: false` for in-memory transient state that skips SQLite and clears on disable/restart); frontend components subscribe via `usePluginDoc(name)`. Secret fields of `ctx.configSchema` go into credential storage, keeping them out of the public doc and `PluginSummary.publicConfig`.
- `ctx.sessionDoc(name, initial, { public: true, durable? })` exposes state sharded per conversation (`durable: true` persists to SQLite; `durable: false` keeps transient state strictly in process memory and auto-clears on disable, conversation deletion, or restart): handles `get/set/update/delete(conversationId, ...)` (e.g. `metrics.update(input.conversationId, cur => ({ count: cur.count + 1 }))`); frontend components subscribe per current conversation with `usePluginSessionDoc("metrics")`; never enters the global first frame or global broadcast -- when public, a dedicated SSE (`GET /api/plugins/:id/docs/:name/events?conversationId=N`) pushes only to clients subscribed to that conversation; conversation deletion cascades cleanup, and writes after deletion are rejected. Session-scoped UI state (per-conversation task lists, run details) always uses sessionDoc instead of doc to avoid global write amplification; doc and sessionDoc must not share a name.
- `ctx.service({ id, start, stop })` manages background services; declaring liveTasks lets in-flight tasks be reported before disabling. Inside service.start you can bootstrap managed skills via `ctx.host.skills.ensureSkill({ id, skillMd, references })` (the standard home for long manuals -- do not stuff them into promptGuidelines):

```ts
const SKILL_MD = `---
name: deploy-guide
description: Deployment playbook (the model decides when to load by this sentence)
managedByPlugin: my-plugin
---

# Deployment
Read references/rollback.md first for rollback scenarios.
`

ctx.service({
  id: 'skill-bootstrap',
  async start() {
    await ctx.host.skills.ensureSkill({
      id: 'deploy-guide',
      skillMd: SKILL_MD,
      references: { 'rollback.md': '# Rollback\n...' },
    })
  },
  async stop() {},
})
```

  `managedByPlugin` must be this plugin's ID (the host validates the binding); the skill automatically leaves the available catalog when the plugin disables and returns on enable, while still being filtered by Profile.skills whitelists (catalog-limited Profiles must opt in explicitly) -- helm-cli follows the same rule and is not always available.

Key points:
- External plugin ids forbid the `builtin:` prefix, forbid name collisions with registered plugins, and cannot self-declare locked; after placing into the directory, `helm plugins rescan` discovers them incrementally (or a Hub restart auto-discovers), registered disabled by default.
- Managed installs: `helm plugins install <source>` supports four sources -- `npm:<spec>`, `git:<repo>@<ref>`, HTTPS Git URLs, and local paths (resolved and fetched by the Hub server; a local path means a path on the Hub host); `helm plugins update <id>` updates, `helm plugins remove <id> [--yes]` removes (a destructive operation requiring confirmation; use --yes non-interactively); install records (PluginPackageRecord) are persisted by the installer, and PluginSummary carries optional managed metadata. Installing and enabling executes trusted plugin code inside the Hub process, with no sandbox -- install only trusted sources. The hand-managed directory route (init + rescan) remains available.
- Enable: `helm plugins enable my-plugin`; after editing entry code use `helm plugins reload my-plugin` for a controlled hot reload (static self-check precheck first; on failure the old instance stays untouched; no Hub restart needed). Disable/enable only rebuilds the lifecycle of existing definitions. Disabling or uninstalling with in-flight tasks is explicitly refused (409 plugin_has_live_tasks).
- Do not restart the Hub inside your own turn; finish delivering results first, then schedule the process restart.
- Frontend React components (client.tsx) compile dynamically via esbuild and may import react / react-dom / lucide-react / @helm/plugin-client (host-shared instances; never bundle a second React). @helm/plugin-client additionally shares the accessible foundation components: Switch, Select, MultiSelect, Checkbox, Tabs/TabsList/TabsTrigger/TabsContent, SegmentedControl, HelmIcon, ViewBoundary, Callout, Dialog/DialogPortal/DialogOverlay/DialogContent/DialogTitle/DialogDescription/DialogClose/DialogTrigger, MarkdownView, MarkdownText, CodeBlockView, CopyButton, PluginSlot, plus the lightweight layout primitives Screen (page container + header), ScreenSection (sectioning), DataTable (composable table shell with unified loading/empty; thead/rows expressed as children JSX), KvGrid (items: Array<{key,value}> key-value overview), and the generic formatting pure functions formatTime (MM-DD HH:mm), formatCompactTimestamp (MM-DD HH:mm:ss), formatDurationMs (millisecond duration summary), formatBytes (human-readable bytes, base 1024) -- prefer reusing these primitives and formatters for common structures instead of building native controls, duplicate formatters, or new CSS themes.
- Shared hooks: usePluginLocale() resolves the active `en` / `zh-CN` UI locale; usePluginTranslator() returns a stable translator for localized display copy; useToolActivity(callId, active) reports background tool activity of the owning timeline turn; usePluginDoc(name, pluginId?) reactively subscribes to public global docs (cross-plugin addressing supported); usePluginSessionDoc(name, {conversationId?, pluginId?}?) subscribes to public session docs per current conversation (multi-component shared subscription; unsubscribes at zero references; first-frame restore on reconnect); useConversations() for all conversation summaries; useConversation(id) for a single conversation's live view (summary/detail/live/pendingAsks); usePlugins() for a reactive snapshot of the host plugin list and Screen contributions (plugins + screens, live-synced via SSE -- app-center-style views use it to sense installed apps and their main views' enablement); usePluginConfig<T>() for the current plugin's reactive non-secret configuration (`PluginSummary.publicConfig`, excluding all `secret: true` fields; returns `{}` when unset; usable inside `<PluginUiView>`); <PluginSlot name> declares child slots; usePluginContext() provides callAction(actionId, input, {pluginId?, conversationId?}) (cross-plugin capable), submitInput(text, {conversationId?, whenBusy?}), openScreen/openSplitScreen/openConversationDrawer/openArtifact/openWorkbench, notify, and more.
- Plugin view styles live in a local .css inside clientRoot (imported; esbuild merges it into the preserved export __helmClientCss, with the host managing injection and reclamation); never write the host's styles.css.
- UI copy strictly forbids Emoji; icons use lucide icon names.
- For the complete extension points and the client.tsx single-track mechanism, see the in-repo docs/architecture/extension-points.md and docs/plugins/plugin-development.md.
- When client.tsx involves heavy dependencies, dynamic imports, first-screen performance, or async chunks, read `references/plugin-client-code-splitting.md` first; that manual specifies the source shape the AI should write, the host bridging internals that must never be touched, verification commands, and failure handling.
