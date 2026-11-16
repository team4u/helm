/**
 * Herdr 执行器子模块：文件交接校验、原地追问自愈与 Gate 执行。
 *
 * 从 executor.ts 拆出（行为与拆分前逐行等价）；依赖经 PaneHandoffPort 注入
 * （executor 持有 registry / transport / 窗格环境基线与机密重新授权 / 结算
 * 等待与失败标记）：
 * - readAndValidateOutput：交接文件读取 + JSON Schema/md 稳定性校验，失败仅
 *   自愈一次（同形追问），再失败显式 herdr_output_contract_violation 并附
 *   agent.read recent_unwrapped 40 行脱敏快照，绝不截终端脏文本冒充结果；
 * - readDiagnostic：40 行脱敏诊断快照（executor / 审批桥共用）；
 * - runGateFor：文件成功后恰好一次（本机 runLocalGate / 远端 transport.runGate，
 *   同一实际 cwd 与路由基线 env；机密不缓存，每次按本次请求 secretNames 从
 *   当前 stash 重新授权，缺失/过期/已结算在 gate 子进程启动前显式 404）。
 *
 * 诚实性纪律（不静默降级）：transport IO/SSH/权限错误如实抛诊断
 * （herdr_output_missing 404 是唯一可自愈边界码），绝不把其它错误当缺文件
 * 重投任务。
 */

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, validateOrThrow, type AgentSpawnRequest } from '@helm/protocol'
import type { HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane } from './panes.js'
import { parsePaneRead, type HerdrAgentInfo } from './rpc.js'
import { redactSchemaText } from './spawn-rules.js'

/** PaneHandoff 对执行器（executor）的最小依赖面。 */
export interface PaneHandoffPort {
  transport: NonNullable<HerdrPluginDependencies['transport']>
  redact(text: string): string
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** AskDoc 目标会话（缺省父会话）。 */
  askConversationId(parentConversationId: number): number
  /** 窗格环境基线（paneEnvs 现值；Gate 与续接共用，不含 stash 机密）。 */
  paneEnvOf(key: string): Record<string, string> | undefined
  /** 从当前 stash 重新授权机密叠加到基线（每次现取，缺失在内核边界显式 404）。 */
  applyPaneSecrets(
    baseline: Record<string, string>,
    parentConversationId: number,
    cwd: string,
    target: HerdrTarget,
    secretNames: string[],
  ): Record<string, string>
  /** prompt --wait（blocked 也可能立即返回，审批桥接管）。 */
  promptAndWait(target: HerdrTarget, pane: ManagedPane, text: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** 结算等待 + blocked 审批桥循环。 */
  waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void>
  /** $helm 状态 Token 投射（自愈追问前标记 heal）。 */
  project(pane: ManagedPane, token: string): Promise<void>
  /** 失败窗格保留现场标记（outcome=failed + 脱敏 failureNote）。 */
  markFailed(pane: ManagedPane, note: string): Promise<void>
  /** 本机 Gate 执行端口（远端走 transport.runGate）。 */
  runLocalGate: HerdrPluginDependencies['runLocalGate']
  /** md 交接稳定性复检间隔（测试可缩短；生产缺省 300ms）。 */
  mdStableRecheckMs?: number
}

export class PaneHandoff {
  /** md 交接稳定性复检的间隔（两次读一致才接受；json 有 schema 硬校验无需此检）。 */
  private static readonly DEFAULT_MD_STABLE_RECHECK_MS = 300

  constructor(private readonly port: PaneHandoffPort) {}

  async readAndValidateOutput(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    const transport = this.port.transport
    const fileName = pane.outputFileName!
    const target = targetOf(pane)
    const readOnce = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      let raw: string
      try {
        raw = await transport.readOutput(target, pane.effectiveCwd, fileName, request.signal)
      } catch (error) {
        if (error instanceof HelmError && error.code === 'herdr_output_missing') {
          return { ok: false, reason: `交接文件缺失：${fileName}`, recoverable: true }
        }
        // 其它 IO/SSH/权限错误：如实抛诊断，不当缺文件自愈。
        throw error
      }
      if (request.schema === undefined) {
        if (raw.trim() === '') return { ok: false, reason: '交接文件为空', recoverable: true }
        return { ok: true, value: this.port.redact(raw) }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        return {
          ok: false,
          reason: `交接文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        }
      }
      try {
        validateOrThrow(request.schema, parsed, '交接文件内容未通过 JSON Schema 校验', 'schema_validation_failed', 502)
        return { ok: true, value: JSON.parse(this.port.redact(JSON.stringify(parsed))) as unknown }
      } catch (err) {
        if (err instanceof HelmError && err.code === 'schema_validation_failed') {
          return { ok: false, reason: err.message, recoverable: true }
        }
        throw err
      }
    }

    /**
     * md 交接的稳定性复检：agent 非原子多段写 + agent.wait 返回 idle 但后台
     * 仍在写时，首读可能拿到截断 Markdown——间隔短时复读一致才接受，否则
     * 按可自愈失败走追问路径（json 路径已有 parse+schema 硬校验，无需此检；
     * 残余风险：两次读间隔内恰好写完且不再变化的前缀截断仍无法区分，由
     * 自愈追问兑底）。
     */
    const readOnceStable = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      const first = await readOnce()
      if (!first.ok || request.schema !== undefined) return first
      const recheckMs = this.port.mdStableRecheckMs ?? PaneHandoff.DEFAULT_MD_STABLE_RECHECK_MS
      await delay(recheckMs, undefined, { signal: request.signal })
      const second = await readOnce()
      if (!second.ok) return second
      if (second.value !== first.value) {
        return { ok: false, reason: '交接文件仍在写入（间隔复读内容不一致）', recoverable: true }
      }
      return first
    }

    let attempt = await readOnceStable()
    if (!attempt.ok) {
      this.port.notify('Herdr 交接自愈', `pane ${pane.paneId} 首次交接失败（${attempt.reason}），追问一次`, 'info')
      await this.port.project(pane, `heal:${pane.agentName}`)
      // 自愈追问本身也可能 blocked：同一审批桥等待真实进展后再读文件，
      // 不能读缺文件就判失败。
      await this.promptAndWaitHeal(request, pane, attempt.reason)
      attempt = await readOnceStable()
    }
    if (!attempt.ok) {
      await this.port.markFailed(pane, attempt.reason)
      const snapshot = await this.readDiagnostic(pane)
      throw new HelmError(
        'herdr_output_contract_violation',
        `pane ${pane.paneId} 两次交接均失败（${attempt.reason}）；窗格保留供人工排查。终端最后 40 行（脱敏）：\n${snapshot}`,
        502,
        { paneId: pane.paneId, reason: attempt.reason, snapshot },
      )
    }
    await transport.removeOutput(target, pane.effectiveCwd, fileName, request.signal)
    return attempt.value
  }

  /** 自愈追问：与首轮同形（prompt --wait + blocked 桥循环）。 */
  private async promptAndWaitHeal(request: AgentSpawnRequest, pane: ManagedPane, reason: string): Promise<void> {
    const target = targetOf(pane)
    const text =
      `你上一轮未按要求交付。${reason}。请立即将最终结果写入 ${pane.effectiveCwd}/.helm/${pane.outputFileName}` +
      (request.schema !== undefined ? `（满足 Schema 的单个 JSON 值）。\nJSON Schema: ${redactSchemaText(request.schema, this.port.redact)}` : '（Markdown 全文）。')
    const info = await this.port.promptAndWait(target, pane, this.port.redact(text), request.signal)
    await this.port.waitUntilSettled(request, pane, info)
  }

  /** agent.read recent_unwrapped 40 行脱敏快照（诊断专用）。 */
  async readDiagnostic(pane: ManagedPane): Promise<string> {
    try {
      const read = parsePaneRead(
        await this.port.transport.call(targetOf(pane), 'agent.read', {
          target: pane.paneId,
          source: 'recent_unwrapped',
          lines: 40,
          format: 'text',
        }, { timeoutMs: 5_000 }),
      )
      return this.port.redact(read.text).slice(-4_000)
    } catch (error) {
      return `[快照读取失败：${error instanceof Error ? this.port.redact(error.message) : String(error)}]`
    }
  }

  /** gate：文件成功后恰好一次；本机 runLocalGate，远端 transport.runGate（同一实际 cwd 与路由基线 env）。 */
  async runGateFor(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const baseline = this.port.paneEnvOf(paneStateKey(pane))
    if (baseline === undefined) throw new HelmError('herdr_context_unavailable', '任务环境已丢失，无法在同一环境执行 Gate', 409)
    const env = this.port.applyPaneSecrets(baseline, request.parentConversationId, pane.effectiveCwd, targetOf(pane), request.secretNames ?? [])
    const gate: { ok: boolean; output: string } =
      nodeIdOf(pane) === undefined
        ? await this.port.runLocalGate(request.gate!, {
            cwd: pane.effectiveCwd,
            conversationId: this.port.askConversationId(request.parentConversationId),
            signal: request.signal,
            env,
          })
        : await this.port.transport.runGate(targetOf(pane), request.gate!, pane.effectiveCwd, request.signal, env)
    request.onGateResult?.({ ...gate, output: this.port.redact(gate.output) })
    if (!gate.ok) {
      await this.port.markFailed(pane, `gate 失败：${request.gate}`)
      throw new HelmError(
        'gate_failed',
        `验收命令失败（exit≠0）：${request.gate}\n${this.port.redact(gate.output).slice(-2000)}`,
        502,
        { output: this.port.redact(gate.output).slice(-4000) },
      )
    }
  }
}
