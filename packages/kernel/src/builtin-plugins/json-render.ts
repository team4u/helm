/**
 * builtin:json-render：声明式 JSON 卡片渲染插件（默认启用、可停用）。
 *
 * 职责（机制与策略分离：内核只提供 markdown 代码块扩展机制，本插件提供策略）：
 * - 注册 markdown.codeBlock 扩展（languages: ui / json-render），client 组件
 *   渲染安全 JSON Spec 卡片（无 eval / 无 Function / 无任意 URL 协议）；
 * - 自举受管技能 generative-ui（SKILL.md + 原语契约 references），随插件启停
 *   进入/离开可用技能目录（停用后模型目录与聊天 ```ui 围栏渲染同时消失，
 *   不留幻影提示词）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'

export const JSON_RENDER_PLUGIN_ID = 'builtin:json-render'

/** 本插件自举的受管技能 ID。 */
export const GENERATIVE_UI_SKILL_ID = 'generative-ui'

/** clientRoot 兼容 src / dist 运行路径（与 workflow/herdr 插件同机制）。 */
function resolveClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'json-render', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'json-render', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'json_render_client_missing',
    `内置插件 ${JSON_RENDER_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

function resolveSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'json-render', 'skill')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'json-render', 'skill')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError('json_render_skill_missing', `内置插件 ${JSON_RENDER_PLUGIN_ID} 找不到技能资产目录`, 500)
}

/** 读取技能资产并渲染模板占位符（与 profile/assets 同机制，保持严格失败）。 */
function readSkillAssets(): { skillMd: string; references: Record<string, string> } {
  const dir = resolveSkillDir()
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf-8')
  const primitives = read('references/primitives.md')
  const actions = read('references/actions.md')
  return {
    skillMd: read('SKILL.md'),
    references: { 'primitives.md': primitives, 'actions.md': actions },
  }
}

export function createJsonRenderPlugin(): PluginDefinition {
  return {
    id: JSON_RENDER_PLUGIN_ID,
    name: 'JSON 卡片渲染',
    description: '聊天 ```ui 代码块渲染：把模型输出的安全 JSON Spec 渲染为交互卡片（表单/列表/图表原语），并随插件启停维护 generative-ui 技能。',
    icon: 'layout',
    version: '0.1.0',
    clientRoot: resolveClientRoot(),
    definePlugin(ctx) {
      ctx.ui.markdownCodeBlock({
        id: 'json-cards',
        languages: ['ui', 'json-render'],
        client: { module: 'index.tsx', export: 'JsonRenderCodeBlock' },
      })

      ctx.service({
        id: 'generative-ui-skill',
        async start() {
          const assets = readSkillAssets()
          await ctx.host.skills.ensureSkill({
            id: GENERATIVE_UI_SKILL_ID,
            skillMd: assets.skillMd,
            references: assets.references,
          })
        },
        async stop() {},
      })
    },
  }
}
