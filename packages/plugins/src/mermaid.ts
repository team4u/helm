/**
 * builtin:mermaid: the Mermaid diagram rendering plugin (enabled by default, disableable).
 *
 * Responsibilities: register the markdown.codeBlock extension (language: mermaid); the client component
 * bundles mermaid into the compiled artifact via a controlled npm dependency (resolution root = the plugin
 * package root, version pinned by pnpm-lock; the kernel knows nothing about the chart library, and the host's browser code preloads nothing).
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { resolvePluginClientRoot } from './asset-paths.js'

export const MERMAID_PLUGIN_ID = 'builtin:mermaid'

/** Find the resolution root of the declared dependency by Node's node_modules walk-up rules from the plugin package location. */
function resolvePluginsPackageRoot(): string {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (;;) {
    if (existsSync(join(root, 'node_modules', 'mermaid', 'package.json'))) return root
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  throw new HelmError('mermaid_dependency_missing', 'the built-in Mermaid plugin runtime dependency is not installed', 500)
}

export function createMermaidPlugin(): PluginDefinition {
  return {
    id: MERMAID_PLUGIN_ID,
    name: { en: 'Mermaid Diagrams', 'zh-CN': 'Mermaid 图表' },
    description: {
      en: 'Chat ```mermaid code-block rendering: renders Mermaid text into flowcharts/sequence diagrams/Gantt charts and other vector diagrams.',
      'zh-CN': '聊天 ```mermaid 代码块渲染：把 Mermaid 文本渲染为流程图/时序图/甘特图等矢量图表。',
    },
    icon: 'git-branch',
    version: '0.1.0',
    clientRoot: resolvePluginClientRoot(MERMAID_PLUGIN_ID, 'mermaid', 'mermaid_client_missing'),
    npmDependencies: { mermaid: resolvePluginsPackageRoot() },
    definePlugin(ctx) {
      ctx.ui.markdownCodeBlock({
        id: 'mermaid-diagram',
        languages: ['mermaid'],
        client: { module: 'index.tsx', export: 'MermaidCodeBlock' },
      })
    },
  }
}
