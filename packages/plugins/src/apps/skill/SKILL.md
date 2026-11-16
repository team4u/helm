---
name: app-builder
description: Use when building reusable full-stack micro-apps (tool desks, boards, reconciliation desks, trackers with frontend, backend, and persistent state) and publishing them to the app center; covers L1 ephemeral cards vs L2 full-stack apps selection, directory conventions, the validate/publish SOP, and code templates.
managedByPlugin: builtin:apps
---

# Building Full-Stack Micro-Apps (App Center)

When the user needs a tool that is "reusable, with its own UI and persistent data", deliver it per this skill's SOP.

## L1 or L2: choose first

- **L1 ephemeral card (```ui code block)**: data tables, metrics, and confirmation forms shown once inside the current conversation; they sink with the conversation, with no persistent state and no backend logic. See the generative-ui skill (`load_skill({ skillId: "generative-ui" })`).
- **L2 full-stack micro-app (this skill)**: tool desks the user explicitly wants to "save/publish/open again later", or that need cross-conversation persistent data, custom backend actions, or a standalone UI. The artifact is a standard helm plugin package published to the app center via `builtin:apps`.

When unsure, ask the user one question; do not guess for them.

## L2 Delivery SOP (four steps, no skipping)

### 1. Planning and directory initialization

By default create under the current workspace `<cwd>/apps/<app-id>/`:

```
apps/<app-id>/
  plugin.json          # { "id": "<app-id>", "main": "index.ts", "clientRoot": "./client" }
  index.ts             # backend: clientRoot: "./client" + ctx.doc / ctx.action / ctx.ui.screen
  client/index.tsx     # frontend: main Screen component
  client/styles.css    # local styles (optional)
```

- `app-id` uses kebab-case (e.g. `bill-desk`); the `builtin:` prefix is forbidden;
- **clientRoot is required**: when frontend components live in a `client/` subdirectory, `index.ts`'s `PluginDefinition` (or `plugin.json`) must declare `clientRoot: './client'` explicitly -- when undeclared the default root is the plugin directory itself, and `apps_validate` fails with a missing client module because it cannot find `index.tsx`;
- UI copy and icons follow the zero-Emoji iron rule; icons use lucide icon names (e.g. layout-grid, list-checks, wallet).

### 2. Full-stack coding constraints and the shared SDK

Backend `index.ts` (a standard `PluginDefinition`):

- `ctx.doc('<name>', initialState, { public: true })` persists global data; use `ctx.sessionDoc('<name>', initialState, { public: true })` for per-conversation state; **`await doc.flush()` after writes**;
- `ctx.action({ id, description, inputSchema, outputSchema, idempotent?, exposeAsTool: true, handler })`: actions must declare **both `inputSchema` and `outputSchema`** (read-only actions use `idempotent: true`); the handler may call `ctx.host.execEnv` to run commands across nodes; actions automatically get the HTTP / CLI / Agent Tool / Workflow / Web five-end mapping;
- **You must register at least one `ctx.ui.screen({ id: 'main', label: '...', client: { module: 'index.tsx', export: 'MainScreen' } })`** -- this is a hard requirement of full-stack apps, and validate enforces it;
- **Do not register `ctx.ui.sidebarItem` by default** (app entries are converged by the app center, preventing sidebar bloat).

Frontend `client/index.tsx` (host shared SDK, import directly without installing):

- **The only allowed runtime bare imports are host shared modules**: `react`, `react-dom`, `lucide-react`, `@helm/plugin-client`; types may use `import type ... from '@helm/protocol'`. For third-party npm packages, declare each one in `plugin.json.clientDependencies` or `package.json.helm.clientDependencies` first, then state the version range in `package.json.dependencies`; otherwise `apps_validate` fails explicitly on undeclared bare dependencies.
- **The `@helm/plugin-client` shared export list**:
  - **Reactive hooks**: `usePluginContext()` (provides `callAction` / `submitInput` / `openScreen` / `openSplitScreen` / `openConversationDrawer` / `openArtifact` / `openWorkbench` / `notify`), `usePluginDoc(name, pluginId?)`, `usePluginSessionDoc(name, opts?)`, `useConversations()`, `useConversation(id)`, `usePlugins()`, `useToolActivity(callId, active)`;
  - **Page layout primitives (prefer these over hand-rolled page scaffolding)**: `Screen` (fullscreen container + standard page header `title/subtitle/actions`), `ScreenSection` (section container `title/titleExtra`), `DataTable` (composable table shell with unified `loading/empty` placeholders; `thead/tbody` expressed as JSX), `KvGrid` (`items: [{ key, value }]` key-value grid);
  - **Accessible controls and content components**: `HelmIcon`, `Switch`, `Select`, `MultiSelect`, `Checkbox`, `Tabs / TabsList / TabsTrigger / TabsContent`, `SegmentedControl`, `Dialog / DialogTrigger / DialogContent / DialogTitle / DialogDescription / DialogClose`, `Callout`, `MarkdownView`, `MarkdownText`, `CodeBlockView`, `CopyButton`, `ViewBoundary`, `PluginSlot`;
- Styling uses host CSS variables (`var(--bg-elevated)`, `var(--border)` etc.) to stay dark/light adaptive; local `.css` files are bundled via `import './styles.css'`; never write the host's styles.css;
- Component files export only components and types (Fast Refresh); the `module` path and named `export` referenced by `client` must match reality (doctor validates compiled artifact exports).

Full runnable template: `load_skill({ skillId: "app-builder", path: "references/fullstack-template.md" })`; for advanced extension points (backend lifecycle hooks, `composerCompleter`, `artifactPreviewer`, workbench panels, etc.), consult `load_skill({ skillId: "helm-cli", path: "references/skill-and-plugin-dev.md" })` on demand.

### 3. Mandatory static self-check (Zero-Broken-App)

After writing or modifying code you **must** invoke the `apps_validate` tool (CLI: `helm apps validate <dir> --json`). It runs the real four-phase checks: manifest / backend TS transpile / real registration assertions / client esbuild compile and export validation, plus the "at least one ctx.ui.screen" check.

- When it returns `ok: false`, fix item by item per the `checks` report (TS types, schemas, or React export errors on the spot) until `ok: true`;
- **Never skip the precheck and deliver anyway**; never fabricate check results.

### 4. Publish or deliver as draft

- When the user wants it directly usable or wants to upgrade an existing app: call `apps_publish` (pass `dir` absolute path, `icon` (lucide name), `category` (productivity/devops/data/finance/automation/other)). On success, output a ```ui delivery card in the reply body with "open the app side-by-side on the right screen" (`{ "type": "helm:open", "target": "screen:<appId>/main", "split": true }`) and "go to the app center" (`{ "type": "helm:open", "target": "screen:builtin:apps/center" }`) buttons;
- When the user wants to review first: only run `apps_validate` and output a ```ui preview card (app structure summary + a "one-click publish to app center" button bound to `{ "type": "helm:action", "pluginId": "builtin:apps", "actionId": "publish", "input": { "dir": "<absDir>", "category": "..." } }`), then wait for the user's click;
- Upgrading a published app: edit the same workspace source and run `apps_publish` again (same source takes the update hot-reload path; data is preserved).

## Boundary facts (tell the user honestly)

- **No sandbox**: published apps are in-process trusted plugin code with host privileges (they can read/write files and execute across nodes); only publish code from trusted sources;
- Path boundary: `validate` / `publish` accept only **Hub-local** (local node) paths; when the conversation is bound to a remote node they fail explicitly instead of guessing same-name paths on the Hub host;
- Published artifacts install to `<dataDir>/plugins/<appId>` (a managed copy, not a symlink): after editing source, publish again to sync; `helm apps remove` uninstalls.
