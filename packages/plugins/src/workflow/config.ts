/**
 * builtin:workflow 插件配置（自 workflow.ts 入口拆出）。
 *
 * 复用宿主配置入口：插件中心与 helm plugins config 同权读写。启动即校验：
 * 非法值在插件定义阶段显式失败，不带病运行；后续读取（深度缺省、并发）
 * 每次现读配置并同口径校验。
 */
import { availableParallelism } from 'node:os'
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  HARD_MAX_SUBAGENT_DEPTH,
} from '../contracts.js'

/** 注册配置 Schema（含按 CPU 并行度计算的并发缺省值）。 */
export function registerWorkflowConfigSchema(ctx: HelmPluginContext): void {
  // 缺省并发按 CPU 并行度计算并限制在 2..32（定义时快照一次）。
  const defaultMaxConcurrentAgents = Math.max(2, Math.min(32, availableParallelism() * 2))
  ctx.configSchema({
    maxConcurrentAgents: {
      type: 'number',
      label: { en: 'Max concurrent subagents per workflow', 'zh-CN': '工作流最大并发子代理数' },
      minimum: 1,
      maximum: 128,
      integer: true,
      description: {
        en: 'Per-run concurrent agent cap; defaults to CPU parallelism clamped to 2..32.',
        'zh-CN': '单个工作流 Run 的并发 agent 上限，默认按 CPU 并行度计算并限制在 2..32。',
      },
      default: defaultMaxConcurrentAgents,
    },
    maxSubagentDepth: {
      type: 'number',
      label: { en: 'Max subagent depth', 'zh-CN': '子代理最大层级' },
      minimum: 1,
      maximum: HARD_MAX_SUBAGENT_DEPTH,
      integer: true,
      description: {
        en: `Integer 1..${HARD_MAX_SUBAGENT_DEPTH}, default 2. The main conversation is depth 0; changes affect newly spawned task trees while existing ones keep their ceiling.`,
        'zh-CN': `1..${HARD_MAX_SUBAGENT_DEPTH} 的整数，默认 2。主会话为第 0 层；变更影响新派生的任务树，现有任务沿用其上限。`,
      },
      default: DEFAULT_MAX_SUBAGENT_DEPTH,
    },
    autoRecoverOnRestart: {
      type: 'boolean',
      label: {
        en: 'Auto-recover tasks on restart',
        'zh-CN': '重启自动恢复任务',
      },
      description: {
        en: 'Automatically suspend and recover in-flight workflows and background subagents in place across Hub restarts; set to false to abort interrupted tasks on shutdown (can also be temporarily disabled via HELM_AUTO_RECOVER=0).',
        'zh-CN': 'Hub 重启后自动原位恢复或挂起在途工作流与后台子代理；设为 false 时回退重启中止收敛模式（也可设环境变量 HELM_AUTO_RECOVER=0 临时关闭）。',
      },
      default: true,
    },
  })
}

/** 是否通过环境变量紧急关闭重启自动恢复（HELM_AUTO_RECOVER=0/false）。 */
export function isAutoRecoverEnvDisabled(): boolean {
  const raw = process.env.HELM_AUTO_RECOVER?.trim().toLowerCase()
  return raw === '0' || raw === 'false'
}

/** 现读并校验 autoRecoverOnRestart（缺省 true；非法类型显式拒绝）。 */
export function readAutoRecoverOnRestart(ctx: HelmPluginContext): boolean {
  const raw = ctx.getConfig().autoRecoverOnRestart
  if (raw === undefined) return true
  if (typeof raw !== 'boolean') {
    throw new HelmError(
      'validation_error',
      `builtin:workflow 配置 autoRecoverOnRestart 非法：${JSON.stringify(raw)}（需布尔值）`,
      500,
      { configured: raw },
    )
  }
  return raw
}

/** 综合配置项与 HELM_AUTO_RECOVER 逃生阀判断是否启用重启自动恢复（任一关闭则回退中止收敛）。 */
export function isEffectiveAutoRecover(ctx: HelmPluginContext): boolean {
  return readAutoRecoverOnRestart(ctx) && !isAutoRecoverEnvDisabled()
}

/** 现读并校验 maxConcurrentAgents（缺省按 CPU 并行度；非法显式拒绝）。 */
export function readMaxConcurrentAgents(ctx: HelmPluginContext): number {
  const raw = ctx.getConfig().maxConcurrentAgents
  if (raw === undefined) return Math.max(2, Math.min(32, availableParallelism() * 2))
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 128) {
    throw new HelmError('validation_error', `builtin:workflow 配置 maxConcurrentAgents 非法：${JSON.stringify(raw)}（需 1..128 的整数）`, 500, { configured: raw })
  }
  return raw
}

/** 现读并校验 maxSubagentDepth（缺省 DEFAULT_MAX_SUBAGENT_DEPTH；非法显式拒绝）。 */
export function readMaxSubagentDepth(ctx: HelmPluginContext): number {
  const raw = ctx.getConfig().maxSubagentDepth
  if (raw === undefined) return DEFAULT_MAX_SUBAGENT_DEPTH
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > HARD_MAX_SUBAGENT_DEPTH) {
    throw new HelmError(
      'validation_error',
      `builtin:workflow 配置 maxSubagentDepth 非法：${JSON.stringify(raw)}（需 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数）`,
      500,
      { configured: raw },
    )
  }
  return raw
}
