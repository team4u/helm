/**
 * builtin:mermaid：Mermaid 图表渲染插件（默认启用、可停用）。
 *
 * 职责：注册 markdown.codeBlock 扩展（language: mermaid），client 组件把
 * mermaid 经受控 npm 依赖 bundle 进编译产物（解析根 = 内核包根，版本随
 * pnpm-lock 锁定；内核不感知具体图表库，宿主浏览器代码零预加载）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'

export const MERMAID_PLUGIN_ID = 'builtin:mermaid'

/** clientRoot 兼容 src / dist 运行路径（与 workflow/json-render 插件同机制）。 */
function resolveClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'mermaid', 'client')
  if (existsSync(local)) return local
  const pkgRoot = resolve(here, '../../..')
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'mermaid', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'mermaid_client_missing',
    `内置插件 ${MERMAID_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

/** 内核包根（提供锁定的 mermaid 解析；受控 npm 依赖边界，不感知其他包）。 */
function resolveKernelPackageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/builtin-plugins/mermaid.js -> 包根；src/builtin-plugins/mermaid.ts -> 包根
  return resolve(here, '../..')
}

export function createMermaidPlugin(): PluginDefinition {
  return {
    id: MERMAID_PLUGIN_ID,
    name: 'Mermaid 图表',
    description: '聊天 ```mermaid 代码块渲染：把 Mermaid 文本渲染为流程图/时序图/甘特图等矢量图表。',
    version: '0.1.0',
    clientRoot: resolveClientRoot(),
    npmDependencies: { mermaid: resolveKernelPackageRoot() },
    definePlugin(ctx) {
      ctx.ui.markdownCodeBlock({
        id: 'mermaid-diagram',
        languages: ['mermaid'],
        client: { module: 'index.tsx', export: 'MermaidCodeBlock' },
      })
    },
  }
}
