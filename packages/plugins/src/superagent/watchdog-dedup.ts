/**
 * builtin:superagent Watchdog 去重状态（私有 ctx.doc 持久化）。
 *
 * - 同 (targetKind,nodeId,targetId,stateChangeSeq) 同类动作恰好一次；未达阈值
 *   绝不预先占坑，跨重启不重复危险动作；
 * - 读入严格校验：结构/键/动作名/seq/at 任一非法显式 superagent_doc_corrupt
 *   上抛（tick 失败并通知诊断），绝不静默回空——回空会令已处理过的危险动作
 *   重新触发（诚实性纪律）。首次声明的默认值（version:1, fired:{}）天然合法；
 *   开发阶段无旧格式兼容；
 * - 已消亡目标的安全淘汰：会话已删（not_found）的历史键直接删除；外部探针
 *   目标需「不在活跃集 + 超限 + 距最后一次动作超陈旧门槛」三条件齐备才淘汰
 *   （防瞬时探针缺失把危险动作去重标记清掉造成重放）；活跃目标绝不淘汰。
 */

import { HelmError, type HelmPluginContext, type PluginDocHandle } from '@helm/protocol'
import type { WatchdogProbe } from '../diagnostics.js'
import { isPlainObject, parseTargetKey, targetKey, type WatchdogNotify } from './watchdog-core.js'

/** 去重文档允许的动作类别（私有 Doc 只信本模块写出的形状）。 */
const DEDUP_ACTIONS: ReadonlySet<string> = new Set(['notify', 'wake', 'abort', 'bridge'])

/** 去重动作类别。 */
export type DedupAction = 'notify' | 'wake' | 'abort' | 'bridge'

export interface DedupMark {
  /** 触发时的权威水位（外部/缺 seq 目标用 -1 哨兵）。 */
  seq: number
  at: number
}

export interface WatchdogDedupDoc {
  version: 1
  fired: Record<string, Record<string, DedupMark>>
}

/** 去重文档键数上限（超限仅淘汰已消亡目标；活跃/近期动作绝不淘汰）。 */
const MAX_DEDUP_KEYS = 256
/** 外部探针缓存条数上限（不在当前活跃集且超限时淘汰）。 */
const MAX_EXTERNAL_PROBE_CACHE = 256
/** 外部键淘汰陈旧度门槛（最后一次动作后仍持续缺失 24h 才算消亡）。 */
const EXTERNAL_EVICT_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * 去重文档读入严格校验：结构/键/动作名/seq（非负整数或哨兵 -1）/at 任一非法
 * → 显式 superagent_doc_corrupt 上抛（tick 失败并通知诊断），绝不静默回空。
 */
function sanitizeDedupDoc(raw: unknown): WatchdogDedupDoc {
  if (!isPlainObject(raw) || raw['version'] !== 1 || !isPlainObject(raw['fired'])) {
    throw corruptDedupDoc('顶层结构非法（需 {version:1, fired:{}}）')
  }
  const fired: WatchdogDedupDoc['fired'] = {}
  for (const [key, actions] of Object.entries(raw['fired'])) {
    if (key.length === 0 || !isPlainObject(actions)) {
      throw corruptDedupDoc(`键 ${JSON.stringify(key)} 的动作表非法`)
    }
    const cleaned: Record<string, DedupMark> = {}
    for (const [action, mark] of Object.entries(actions)) {
      if (!DEDUP_ACTIONS.has(action)) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 含未知动作 ${JSON.stringify(action)}`)
      }
      if (!isPlainObject(mark)) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 动作 ${action} 的标记非法`)
      }
      const seq = mark['seq']
      const at = mark['at']
      // seq 仅允许非负整数或外部/缺水位哨兵 -1；at 必须非负整数。
      if (!((typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) || seq === -1)) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 动作 ${action} 的 seq 非法：${String(seq)}`)
      }
      if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 动作 ${action} 的 at 非法：${String(at)}`)
      }
      cleaned[action] = { seq: seq as number, at: at as number }
    }
    fired[key] = cleaned
  }
  return { version: 1, fired }
}

function corruptDedupDoc(detail: string): HelmError {
  return new HelmError(
    'superagent_doc_corrupt',
    `Watchdog 去重文档损坏（${detail}）——拒绝继续巡检以防已处理动作重放；请人工核查插件 doc watchdog-dedup`,
    500,
    { detail },
  )
}

/** 当前 tick 活跃外部探针键集（与去重键同构）。 */
export function collectActiveExternalKeys(probes: WatchdogProbe[]): Set<string> {
  const keys = new Set<string>()
  for (const probe of probes) {
    if (probe.targetKind !== 'external') continue
    keys.add(targetKey('external', probe.nodeId, probe.targetId))
  }
  return keys
}

export interface WatchdogDedupStoreDeps {
  /** 最近一轮外部探针事实缓存（inspect 只读诊断共用；淘汰时同步收敛）。 */
  externalProbes: Map<string, WatchdogProbe>
  notify: WatchdogNotify
  isClosing: () => boolean
}

export class WatchdogDedupStore {
  /** 陈旧预算告警一次性标记（避免每 tick 刷屏；重启后可重新告警）。 */
  private staleBudgetWarned = false

  constructor(
    private readonly doc: PluginDocHandle<WatchdogDedupDoc>,
    private readonly ctx: HelmPluginContext,
    private readonly deps: WatchdogDedupStoreDeps,
  ) {}

  read(): WatchdogDedupDoc {
    return sanitizeDedupDoc(this.doc.get())
  }

  /** 关闭周期不再写去重状态；活动周期的所有存储错误如实传播。 */
  private write(value: WatchdogDedupDoc): void {
    if (this.deps.isClosing()) return
    this.doc.set(value)
  }

  shouldFire(key: string, action: DedupAction, seq: number, refractoryMs: number): boolean {
    const mark = this.read().fired[key]?.[action]
    if (mark === undefined) return true
    if (mark.seq !== seq) return true // 新权威水位 = 新事件，可再次触发
    return Date.now() - mark.at >= refractoryMs
  }

  /** 撤销去重标记（bridge 创建/等待失败时恢复重试权；仅生命周期失效豁免写失败）。 */
  unmarkFired(key: string, action: DedupAction): void {
    const doc = this.read()
    const actions = doc.fired[key]
    if (actions === undefined) return
    delete actions[action]
    if (Object.keys(actions).length === 0) delete doc.fired[key]
    else doc.fired[key] = actions
    this.write(doc)
  }

  markFired(key: string, action: DedupAction, seq: number): void {
    const doc = this.read()
    const actions = doc.fired[key] ?? {}
    // 每目标每动作仅保最新标记（写入即覆盖），不淘汰历史键——淘汰会让旧危险
    // 动作重新获得触发权；已确认消亡的目标经 evictStaleTargets 统一回收。
    actions[action] = { seq, at: Date.now() }
    doc.fired[key] = actions
    this.write(doc)
  }

  /**
   * 已消亡目标的安全淘汰：会话已删（not_found）的历史键直接删除（目标不存在
   * 了无从重放）；外部探针目标需同时满足三条件才淘汰（防瞬时探针缺失把危险
   * 动作去重标记清掉造成重放）：① 不在当前活跃探针集；② 总键数超上限；
   * ③ 该键最后一次动作距今超过 EXTERNAL_EVICT_AFTER_MS（刚触发过 notify/wake
   * 等动作的键即便瞬时缺失也绝不淘汰——网络抖动/单 tick 未采到不是消亡证据）。
   * 活跃目标绝不淘汰。
   */
  evictStaleTargets(activeProbeKeys: ReadonlySet<string>): void {
    const doc = this.read()
    let mutated = false
    // 外部探针缓存同样收敛：不在当前活跃集且超限时淘汰。
    if (this.deps.externalProbes.size > MAX_EXTERNAL_PROBE_CACHE) {
      for (const key of [...this.deps.externalProbes.keys()]) {
        if (this.deps.externalProbes.size <= MAX_EXTERNAL_PROBE_CACHE) break
        if (!activeProbeKeys.has(key)) this.deps.externalProbes.delete(key)
      }
    }
    for (const key of [...Object.keys(doc.fired)]) {
      const parsed = parseTargetKey(key)
      if (parsed === undefined) continue
      if (parsed.kind === 'conversation') {
        // 已删除会话：目标已消亡，无从重放，安全删除。
        const id = Number(parsed.targetId)
        if (!Number.isInteger(id) || id <= 0) {
          delete doc.fired[key]
          mutated = true
          continue
        }
        try {
          this.ctx.host.getConversation(id)
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') {
            delete doc.fired[key]
            mutated = true
          }
          // 其它错误（宿主故障）不淘汰：诚实保留，下轮重试。
        }
        continue
      }
      // 外部目标：仍在活跃探针集则保留；否则需超限 + 距最后一次动作超过
      // 陈旧门槛才淘汰（迭代序即插入序，最旧优先）。
      if (activeProbeKeys.has(key)) continue
      if (Object.keys(doc.fired).length > MAX_DEDUP_KEYS && this.isExternalKeyStale(doc.fired[key]!)) {
        delete doc.fired[key]
        mutated = true
      }
    }
    if (mutated) this.write(doc)
  }

  /** 外部键陈旧判定：全部动作标记都早于 EXTERNAL_EVICT_AFTER_MS 才算消亡。 */
  private isExternalKeyStale(actions: Record<string, DedupMark>): boolean {
    const marks = Object.values(actions)
    if (marks.length === 0) return true // 无动作标记：无重放风险，可直接淘汰
    const latest = Math.max(...marks.map((m) => m.at))
    if (Date.now() - latest >= EXTERNAL_EVICT_AFTER_MS) return true
    // 近期仍有动作但持续缺失：保留（不淘汰）。若外部键总量已远超预算（3x）
    // 则一次性告警（内存保护兜底诊断，仍不自动清除——淘汰导致危险动作重放
    // 的代价大于内存占用）。
    if (!this.staleBudgetWarned && this.countExternalKeys() > MAX_DEDUP_KEYS * 3) {
      this.staleBudgetWarned = true
      this.deps.notify(
        'warning',
        'Watchdog 去重文档外部键超预算',
        `去重文档外部目标键 ${this.countExternalKeys()} 个远超预算 ${MAX_DEDUP_KEYS}，但均未达 ${EXTERNAL_EVICT_AFTER_MS / 3_600_000}h 消亡门槛；为防危险动作重放暂不淘汰，请人工核查外部探针目标集`,
      )
    }
    return false
  }

  /** 当前 doc 中外部目标键计数。 */
  private countExternalKeys(): number {
    let n = 0
    for (const key of Object.keys(this.read().fired)) {
      const parsed = parseTargetKey(key)
      if (parsed?.kind === 'external') n += 1
    }
    return n
  }
}
