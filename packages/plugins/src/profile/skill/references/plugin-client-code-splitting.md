# Plugin client.tsx Performance and Code Splitting

This manual targets AIs developing Helm plugins. Default principle: **the AI writes only standard TypeScript/React and standard ESM `import()`; the host handles compilation, chunking, auth, caching, preloading, and invalidation.**

## First decide whether you need this manual

Read this manual before touching plugin code when any of the following applies:

- client.tsx pulls in Mermaid, editors, charts, parsers, maps, or other heavy dependencies;
- users report slow first open, large network downloads, or slow main-thread parsing for a plugin;
- you need `import()`, async chunks, or bundle splitting;
- you need to check a plugin client artifact's size, gzip size, or chunk caching;
- you need to troubleshoot chunk load failures after plugin disable/reload/refresh.

Ordinary small plugins need no extra abstraction just for splitting.

## How the AI should write plugin code

### Separate first screen from infrequent features

First-screen-critical, tiny code uses static imports:

```tsx
import { useState } from 'react'
import { usePluginContext } from '@helm/plugin-client'
import './styles.css'
```

Heavy, rarely used, or only-after-user-action features use standard dynamic imports:

```tsx
async function openAdvancedView(source: string) {
  const { renderAdvancedView } = await import('./advanced-view.ts')
  return renderAdvancedView(source)
}
```

If a third-party library itself supports dynamic import, prefer loading the library dynamically:

```tsx
const { default: chart } = await import('chart-library')
```

Built-in plugins can declare the dependency via controlled `npmDependencies`; external plugins declare each bare package name or subpath specifier in `plugin.json.clientDependencies` or `package.json.helm.clientDependencies` (the host maps them to controlled dependencies whose resolution root points at the plugin's own directory, and auto-installs them during managed installation); undeclared bare npm specifiers are explicitly rejected by the compiler.

### Keep the entry module light

The entry module contains only:

- components exported for host extension points;
- first-screen-necessary state and event handling;
- small pure functions;
- low-volume style entries.

Never statically import at the entry module's top level a heavy library needed only on button click, dialog open, or a specific data type.

### Dynamic imports keep standard ESM semantics

Dynamic imports must be plain standard form:

```ts
const mod = await import('./feature.ts')
```

Do not hand-rewrite them into host bridge calls. The compiler analyzes dynamic imports, generates the main module, shared chunks, and on-demand chunks, and rewrites them into host loading bridges at the artifact stage.

## Internal mechanisms the AI must never touch

Plugin source must not:

- call `globalThis.__helm_import_chunk` directly;
- read or write `globalThis.__helm_chunk_share` directly;
- hand-write `/api/plugins/<id>/client.mjs` chunk URLs;
- read, splice, or forge `contentHash`;
- put Bearer tokens into URLs;
- depend on relative paths of Blob URLs;
- hand-create or cache chunk filenames;
- execute module code via `eval`, `new Function`, or string concatenation;
- copy files outside clientRoot into runtime paths to bypass the compiler boundary.

These mechanisms belong to the host implementation. Plugins declare only normal module dependencies.

## Import and shared-dependency rules

Importing host shared hooks, components, and contexts from `@helm/plugin-client` is allowed; using the host-declared shared React, React DOM, and lucide-react specifiers is allowed. Do not copy React inside a plugin or hand-write host shared globals.

Plugin-local relative dependencies must live inside `clientRoot`. External plugins must not depend on undeclared bare npm packages; the compiler rejects them explicitly instead of silently searching node_modules.

Plugin styles should import relatively from inside clientRoot:

```tsx
import './styles.css'
```

Never modify the host's `packages/web/src/styles.css` to carry plugin business styles. Never treat local image, font, or CSS resource URLs as plugin static-asset endpoints; use inline `data:` or explicit HTTP(S) addresses per existing plugin development rules.

## Runtime behavior

The host automatically:

1. analyzes the entry and dynamic imports with esbuild;
2. generates the main module, shared async chunks, and private async chunks;
3. produces content hashes and gzip for artifacts;
4. serves chunks on demand over Bearer-authenticated HTTP endpoints;
5. merges concurrent requests for the same module and chunk;
6. loads shared chunks in dependency-topological order;
7. cleans chunks after disable, reload, logout, or cache-generation changes;
8. returns explicit staleness errors for old hashes instead of silently treating old modules as new.

Therefore the AI must not implement a second loader or hand-write fallbacks based on network state inside components. Load failures must keep the host's explicit error semantics.

## Failure-handling rules

When a dynamic dependency fails to load:

- do not return an empty component pretending success;
- do not swallow the import error;
- do not disguise source text as a rendered result;
- show a clear error with a retry entry at the component layer;
- keep user-copyable source or input content (if the component handles user input).

Asynchronous render results must have unmount/parameter-change/cache-generation guards; late results must not overwrite new state.

## Development verification

External plugins run the real self-check first:

```bash
helm plugins doctor <plugin-id-or-directory>
```

After code changes, use the controlled hot reload:

```bash
helm plugins reload <plugin-id>
```

Inspect the entry artifact:

```bash
helm plugins client <plugin-id> --module client.tsx --json
```

To inspect an async chunk:

```bash
helm plugins client <plugin-id> --module client.tsx --chunk <chunk-name> --json
```

Never judge optimization complete from source line counts or theoretical values. Judge by actual compilation results, gzip bytes, the browser Network panel, and real chart/feature operations.

Related tests:

```bash
pnpm typecheck
pnpm --filter @helm/kernel test test/plugin-client.test.ts
pnpm --filter @helm/web test test/plugin-client-chunks.test.ts
pnpm --filter @helm/web test test/plugin-client-css.test.ts test/plugin-client-runtime.test.ts
```

Test cases follow project conventions, explicitly setting `{ timeout: 60_000 }`. When a command fails, report the failing items and logs honestly; never fake a pass with empty implementations, mock data, or silent degradation.

## Completion criteria

A plugin client.tsx change may only be declared complete when all of the following hold:

- the entry and component exports satisfy the clientRoot / ClientComponentRef contract;
- heavy low-frequency dependencies use standard dynamic imports, never unconditionally loaded on the first screen;
- no direct touching of host chunk bridges, hashes, or Bearer URLs;
- `helm plugins doctor` passes;
- related kernel/web tests pass;
- failure paths still show clear diagnostics;
- if you claim a performance optimization, provide actual gzip sizes of the main bundle and chunks, or browser network verification.
