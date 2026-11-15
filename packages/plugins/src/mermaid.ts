/**
 * builtin:mermaid：Mermaid 图表渲染插件（默认启用、可停用）。
 *
 * 职责：注册 markdown.codeBlock 扩展（language: mermaid），client 组件把
 * mermaid 经受控 npm 依赖 bundle 进编译产物（解析根 = 插件包根，版本随
 * pnpm-lock 锁定；内核不感知具体图表库，宿主浏览器代码零预加载）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { resolvePluginClientRoot } from './asset-paths.js'

export const MERMAID_PLUGIN_ID = 'builtin:mermaid'

/** 从插件包位置按 Node 的逐级 node_modules 规则找到声明依赖的解析根。 */
function resolvePluginsPackageRoot(): string {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (;;) {
    if (existsSync(join(root, 'node_modules', 'mermaid', 'package.json'))) return root
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  throw new HelmError('mermaid_dependency_missing', '内置 Mermaid 插件的运行时依赖未安装', 500)
}

export function createMermaidPlugin(): PluginDefinition {
  return {
    id: MERMAID_PLUGIN_ID,
    name: 'Mermaid 图表',
    description: '聊天 ```mermaid 代码块渲染：把 Mermaid 文本渲染为流程图/时序图/甘特图等矢量图表。',
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
