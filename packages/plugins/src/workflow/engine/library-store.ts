/**
 * library-store.ts — 已保存工作流的文件库（自 WorkflowService 拆出的内部模块）。
 *
 * <dataDir>/workflows/<name>.js 是唯一真源：
 * - 名称安全（SAFE_NAME 防路径穿越）+ symlink 越界拒绝（realpath 必须解析回
 *   workflows 目录内同名位置）；
 * - 覆盖默认拒绝（409 workflow_already_exists），原子写入（同目录临时文件 +
 *   fsync；新建 link 原子占位、覆盖 rename 原子替换）；
 * - save(fromRunId) 的脚本源解析经注入的 loadRunRecord 回调走 run store。
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { HelmError } from '@helm/protocol'
import type {
  SavedWorkflowDetail,
  SavedWorkflowSummary,
  WorkflowDeleteResult,
  WorkflowSaveRequest,
  WorkflowSaveResult,
} from '../../contracts.js'
import { extractMeta, hasMetaDeclaration, type WorkflowMeta } from './meta.js'
import { MAX_SCRIPT_LENGTH, precheckScriptSyntax } from './runtime.js'

/** 已保存工作流的安全名称：字母数字开头，限 [A-Za-z0-9._-]，防路径穿越。 */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 真实文件事实（mtime 毫秒 + 字节数）；读取失败显式抛 io_error。 */
export function fileStatsOf(path: string): { updatedAt: number; size: number } {
  try {
    const stats = statSync(path)
    return { updatedAt: Math.trunc(stats.mtimeMs), size: stats.size }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    throw new HelmError('io_error', `无法读取文件事实 ${path}：${err.message}`, 500, {
      path,
      code: err.code,
    })
  }
}

/** 单个脚本的元数据损坏不阻断整个目录；保留该条目并返回诊断。 */
function summaryFromSource(
  name: string,
  path: string,
  source: string,
  stats: { updatedAt: number; size: number },
): SavedWorkflowSummary {
  try {
    const { meta } = extractMeta(source)
    return {
      name,
      path,
      updatedAt: stats.updatedAt,
      size: stats.size,
      description: meta.description,
      ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
      ...(meta.phases !== undefined ? { phases: meta.phases } : {}),
    }
  } catch (error) {
    return { name, path, updatedAt: stats.updatedAt, size: stats.size, metadataError: error instanceof Error ? error.message : String(error) }
  }
}

/** save(fromRunId) 解析脚本源所需的持久记录切面（与 run-store 的 RunRecord 结构兼容）。 */
export interface RunScriptSourceRecord {
  kind?: 'workflow' | 'subagent'
  script?: string
  scriptPath?: string
}

export interface WorkflowLibraryOptions {
  dataDir: string
  /** run 记录读取切面（not_found 等由 run store 原样抛出）。 */
  loadRunRecord(runId: string): RunScriptSourceRecord
}

export class WorkflowLibrary {
  private readonly dataDir: string
  private readonly loadRunRecord: (runId: string) => RunScriptSourceRecord

  constructor(options: WorkflowLibraryOptions) {
    this.dataDir = options.dataDir
    this.loadRunRecord = options.loadRunRecord
  }

  workflowsDir(): string {
    return join(this.dataDir, 'workflows')
  }

  /** 列出带 meta 声明的工作流脚本；非法 meta 附 metadataError，文件读取错误显式失败。 */
  list(): SavedWorkflowSummary[] {
    const dir = this.workflowsDir()
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      // 目录尚不存在：空列表是事实，不是降级。
      if (err.code === 'ENOENT') return []
      throw new HelmError('io_error', `无法读取工作流目录 ${dir}：${err.message}`, 500, {
        path: dir,
        code: err.code,
      })
    }
    const out: SavedWorkflowSummary[] = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.js')) continue
      const name = entry.slice(0, -3)
      if (!SAFE_NAME.test(name)) continue
      const path = join(dir, entry)
      let source: string
      try {
        source = readFileSync(path, 'utf-8')
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        // 列表是尽力而为的目录视图：单个文件不可读跳过但不隐瞒。
        if (err.code === 'ENOENT') continue
        throw new HelmError('io_error', `无法读取工作流脚本 ${path}：${err.message}`, 500, {
          path,
          code: err.code,
        })
      }
      // 非 workflow 的普通 .js（构建产物、草稿）不应出现在列表里。
      if (!hasMetaDeclaration(source)) continue
      const stats = fileStatsOf(path)
      out.push(summaryFromSource(name, path, source, stats))
    }
    return out
  }

  /** 读取已保存工作流的完整定义（只读源码 + 元数据 + 真实文件事实）。 */
  get(name: string): SavedWorkflowDetail {
    const path = this.resolveSavedName(name)
    const source = this.readScriptFile(path)
    const stats = fileStatsOf(path)
    return { ...summaryFromSource(name, path, source, stats), script: source }
  }

  /**
   * 保存工作流定义（script / fromRunId 恰一）：
   * - 严格边界校验 + validateScript 全量检查 + 与 worker 同形状的纯语法预检
   *   （compile-only，零副作用）；
   * - 名称安全（SAFE_NAME 防路径穿越）；显式 name 与 meta.name 不一致拒绝；
   * - 覆盖默认拒绝（409 workflow_already_exists），overwrite: true 才覆盖；
   * - 原子写入：同目录临时文件 + fsync，新建经 link 原子占位（并发同名
   *   创建恰好一个成功），覆盖经 rename 原子替换；
   * - 防符号链接逃逸：目标存在时 realpath 必须仍在 workflows 目录内同名位置。
   */
  save(request: WorkflowSaveRequest): WorkflowSaveResult {
    const sources = [request.script, request.fromRunId].filter((v) => v !== undefined)
    if (sources.length !== 1) {
      throw new HelmError(
        'validation_error',
        'save 需要 script 或 fromRunId 恰好提供一个',
        400,
        { provided: sources.length },
      )
    }

    let script: string
    if (request.script !== undefined) {
      script = request.script
    } else {
      const record = this.loadRunRecord(request.fromRunId!)
      if (record.kind === 'subagent') {
        throw new HelmError(
          'validation_error',
          `运行 ${request.fromRunId} 是后台子代理（subagent），没有可保存的工作流脚本`,
          400,
          { runId: request.fromRunId, kind: 'subagent' },
        )
      }
      if (record.script !== undefined) {
        script = record.script
      } else if (record.scriptPath !== undefined) {
        script = this.readScriptFile(record.scriptPath)
      } else {
        throw new HelmError(
          'validation_error',
          `运行 ${request.fromRunId} 未持久化脚本源（无内联 script 与 scriptPath），无法保存`,
          400,
          { runId: request.fromRunId },
        )
      }
    }

    let meta: WorkflowMeta
    try {
      meta = precheckScriptSyntax(script).meta
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HelmError('workflow_script_invalid', `工作流脚本校验失败：${message}`, 400)
    }

    const name = request.name ?? meta.name
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `工作流名称 "${name}" 非法：需匹配 ${SAFE_NAME.source}（防路径穿越）`,
        400,
        { name },
      )
    }
    if (request.name !== undefined && request.name !== meta.name) {
      throw new HelmError(
        'validation_error',
        `保存名称 ${request.name} 与脚本 meta.name "${meta.name}" 不一致；请先统一名称`,
        400,
        { name: request.name, metaName: meta.name },
      )
    }

    const dir = this.workflowsDir()
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${name}.js`)
    const existing = this.savedEntryStats(name, target)
    if (existing !== undefined && request.overwrite !== true) {
      throw new HelmError(
        'workflow_already_exists',
        `已存在同名工作流 ${name}（${target}）；需 overwrite: true 才覆盖`,
        409,
        { name, path: target },
      )
    }

    // 原子写入：同目录临时文件 + fsync；新建 link 原子占位（并发创建恰好一个
    // 成功），覆盖 rename 原子替换。临时文件名不以 .js 结尾，不会泄入 list()。
    const tmp = join(dir, `.save-${name}-${randomUUID()}.tmp`)
    try {
      const fd = openSync(tmp, 'wx', 0o644)
      try {
        writeSync(fd, script, null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (existing === undefined) {
        try {
          linkSync(tmp, target)
        } catch (error) {
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EEXIST') {
            throw new HelmError(
              'workflow_already_exists',
              `已存在同名工作流 ${name}（并发写入已抢先创建）；需 overwrite: true 才覆盖`,
              409,
              { name, path: target },
            )
          }
          throw error
        }
        unlinkSync(tmp)
      } else {
        renameSync(tmp, target)
      }
    } catch (error) {
      // 临时文件清理尽力而为：清理失败不是业务结果的一部分（tmp 不泄入 list）。
      try {
        unlinkSync(tmp)
      } catch {
        // 已被 rename/link 消费或本就不存在
      }
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('io_error', `写入工作流定义 ${target} 失败：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }

    // 真实摘要：保存后从真实 fs 重新读事实（不返回入参拼装的假状态）。
    const written = fileStatsOf(target)
    return {
      created: existing === undefined,
      workflow: summaryFromSource(name, target, script, written),
    }
  }

  /** 删除已保存工作流定义文件（历史 run 记录不受影响；不存在显式 404）。 */
  delete(name: string): WorkflowDeleteResult {
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `工作流名称 "${name}" 非法：需匹配 ${SAFE_NAME.source}（防路径穿越）`,
        400,
        { name },
      )
    }
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(target)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        throw new HelmError('not_found', `工作流 ${name} 不存在`, 404, { name, path: target })
      }
      throw new HelmError('io_error', `无法读取工作流定义条目 ${target}：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
    // 符号链接：realpath 必须解析回 workflows 目录内同名位置（目录外一律拒绝，
    // 既不删目标也不删链接本身——链接存在即目录已被动过手脚，交人类处置）。
    if (entry.isSymbolicLink()) {
      const real = realpathSync(target)
      const expected = join(realpathSync(dir), `${name}.js`)
      if (real !== expected) {
        throw new HelmError(
          'validation_error',
          `工作流 "${name}" 是指向目录外的符号链接（${real}），已拒绝删除`,
          400,
          { name, real },
        )
      }
    } else if (!entry.isFile()) {
      throw new HelmError(
        'validation_error',
        `工作流定义条目 ${target} 不是常规文件，已拒绝删除`,
        400,
        { name, path: target },
      )
    }
    try {
      unlinkSync(target)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      throw new HelmError('io_error', `删除工作流定义 ${target} 失败：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
    return { deleted: true, name, path: target }
  }

  /**
   * 保存目标的现存条目检查：返回真实文件事实，或 undefined（不存在）。
   * 符号链接指到目录外（resolveSavedName 同款 realpath 校验）一律拒绝。
   */
  private savedEntryStats(name: string, target: string): { updatedAt: number; size: number } | undefined {
    try {
      // resolveSavedName 对不存在目标返回路径本身，对越界 symlink 显式拒绝。
      const resolved = this.resolveSavedName(name)
      const stats = statSync(resolved)
      if (!stats.isFile()) {
        throw new HelmError(
          'validation_error',
          `工作流定义条目 ${target} 不是常规文件，无法覆盖`,
          400,
          { name, path: target },
        )
      }
      return { updatedAt: Math.trunc(stats.mtimeMs), size: stats.size }
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return undefined
      throw new HelmError('io_error', `无法检查工作流定义条目 ${target}：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  resolveSavedName(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `工作流名称 "${name}" 非法：需匹配 ${SAFE_NAME.source}（防路径穿越）`,
        400,
        { name },
      )
    }
    // SAFE_NAME 已排除 '/'，但 symlink 可能把名字重新指到目录外：realpath 校验
    // 解析后的真实路径仍在 workflows 目录内。
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    try {
      const real = realpathSync(target)
      const realDir = realpathSync(dir)
      if (real !== join(realDir, `${name}.js`)) {
        throw new HelmError(
          'validation_error',
          `工作流 "${name}" 是指向目录外的符号链接（${real}），已拒绝`,
          400,
          { name, real },
        )
      }
      return target
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return target // 不存在：readScriptFile 报 not_found
      throw new HelmError('io_error', `无法解析工作流路径 ${target}：${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  resolveExplicitPath(scriptPath: string): string {
    // 显式用户文件路径：可读即用，不承诺沙箱（与文档一致）。
    return resolve(scriptPath)
  }

  readScriptFile(path: string): string {
    let source: string
    try {
      const st = statSync(path)
      if (!st.isFile()) {
        throw new HelmError('not_found', `工作流脚本不是常规文件：${path}`, 404, { path })
      }
      source = readFileSync(path, 'utf-8')
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('not_found', `工作流脚本文件不可读（${err.code ?? 'unknown'}）：${path}`, 404, {
        path,
        code: err.code,
      })
    }
    if (source.length > MAX_SCRIPT_LENGTH) {
      throw new HelmError(
        'validation_error',
        `工作流脚本 ${source.length} 字符，超过上限 ${MAX_SCRIPT_LENGTH}`,
        400,
        { path },
      )
    }
    return source
  }

  /** 提取完整 meta（失败回退 undefined，完整校验在引擎 validateScript）。 */
  peekMeta(script: string): WorkflowMeta | undefined {
    try {
      return extractMeta(script).meta
    } catch {
      return undefined
    }
  }
}
