/**
 * MemoryStore：builtin:memory 插件自治的 MEMORY.md 文件存储。
 *
 * - 管理 `<dataDir>/profiles/<profileId>/MEMORY.md` 的读写与初始化；
 * - 复用内核 fs-atomic 通用原语（withFileLock / atomicWriteFile / readTextFile），
 *   进程内按真实路径串行化，原子落盘（AssetWatcher 实时感知且绝不见半截内容）；
 * - 所有写入路径在文件锁内对**合并后**的最终内容统一强制 64_000 字符上限：
 *   并发调用不可能各自「预读旧值 + 检查通过」后叠加突破上限；超限显式抛
 *   HelmError('memory_limit_exceeded', 400)，不写半截文件。
 */
import { join } from 'node:path'
import { HelmError } from '@helm/protocol'
import {
  FileNotFoundError,
  atomicWriteFile,
  readTextFile,
} from '../../services/atomic-file.js'
import { withFileLock } from '../../services/file-lock.js'
import { assertProfileId } from '../../services/profiles-skills.js'

/** builtin:memory 插件 ID。 */
export const MEMORY_PLUGIN_ID = 'builtin:memory' as const

/**
 * MEMORY.md 长期记忆字符上限（防线单一事实来源）：
 * 长期记忆逐回合全量注入系统提示，无上限会让每次调用成本无界增长。
 */
export const MAX_MEMORY_CHARS = 64_000

/** 初始化默认内容（首条记忆前的合法占位骨架）。 */
export const MEMORY_DEFAULT = ['# Memory', '', ''].join('\n')

function memoryPath(dataDir: string, profileId: string): string {
  return join(dataDir, 'profiles', profileId, 'MEMORY.md')
}

/** 上限拒绝统一错误。 */
export function memoryLimitError(
  profileId: string,
  wouldBe: number,
  mode: 'append' | 'replace',
  inputLength: number,
): HelmError {
  return new HelmError(
    'memory_limit_exceeded',
    `MEMORY.md 写入后达 ${wouldBe} 字符，超过上限 ${MAX_MEMORY_CHARS}；请精简后再写入（长期记忆请整体 replace 整理）`,
    400,
    { profileId, wouldBe, limit: MAX_MEMORY_CHARS, mode, inputLength },
  )
}

export class MemoryStore {
  constructor(private readonly dataDir: string) {}

  /**
   * 文件锁内检查并初始化 MEMORY.md：不存在则写入 MEMORY_DEFAULT。
   * 返回当前全文（已存在时原样返回，不覆盖用户内容）。
   */
  async ensureMemory(profileId: string): Promise<string> {
    assertProfileId(profileId)
    const path = memoryPath(this.dataDir, profileId)
    return withFileLock(path, async () => {
      const current = await readTextFile(path).catch((err: unknown) => {
        if (err instanceof FileNotFoundError) return undefined
        throw err
      })
      if (current !== undefined) return current
      await atomicWriteFile(path, MEMORY_DEFAULT)
      return MEMORY_DEFAULT
    })
  }

  /** 读取全文；文件不存在抛 FileNotFoundError（调用方区分惰性初始化与误删）。 */
  async getMemory(profileId: string): Promise<string> {
    assertProfileId(profileId)
    return readTextFile(memoryPath(this.dataDir, profileId))
  }

  /**
   * 原子更新 MEMORY.md：replace 整体替换；append 追加（保尾部换行）。
   * append 的读改写按该文件真实路径加进程内共享锁串行化。
   * 上限在锁内对合并后的最终内容统一强制（唯一权威点）。
   */
  async updateMemory(
    profileId: string,
    text: string,
    mode: 'append' | 'replace',
  ): Promise<string> {
    assertProfileId(profileId)
    if (typeof text !== 'string') throw new Error('memory 文本必须是字符串')
    const path = memoryPath(this.dataDir, profileId)
    return withFileLock(path, async () => {
      let next: string
      if (mode === 'replace') {
        next = text
      } else {
        let current = ''
        try {
          current = await readTextFile(path)
        } catch (err) {
          if (!(err instanceof FileNotFoundError)) throw err
          // MEMORY.md 缺失时 append 视为从空开始（下次写入自愈重建）。
        }
        next = current.endsWith('\n') || current === '' ? current + text : current + '\n' + text
      }
      if (next.length > MAX_MEMORY_CHARS) {
        throw memoryLimitError(profileId, next.length, mode, text.length)
      }
      await atomicWriteFile(path, next)
      return next
    })
  }
}
