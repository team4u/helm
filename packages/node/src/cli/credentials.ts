/**
 * CLI 凭据：<dataDir>/credentials.json 的 `cli` 键（hubUrl + token），0600 原子写。
 * 该文件同时承载 Hub 的密钥等键——读-改-写必须持锁并保留其他键，绝不整体覆盖。
 * 跨进程锁协议与 @helm/kernel CredentialService 完全一致：
 *   锁文件 = credentials.json.lock，O_EXCL 创建，首字段为持有者 PID；
 *   仅 PID 确认死亡时破除 stale（不按存活时长强拆），坏锁内容显式报错；
 *   释放仅移除自己持有的锁。双方互认，互相排队。
 */
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { CliError } from './errors.js'

export interface CliCredential {
  hubUrl?: string
  token?: string
}

const LOCK_WAIT_MS = 10_000
const LOCK_POLL_MS = 25

export function dataDirFor(env: NodeJS.ProcessEnv): string {
  const v = env['HELM_DATA_DIR']
  if (v && v.trim()) return v.trim()
  return path.join(os.homedir(), '.helm')
}

export function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'credentials.json')
}

/** 读取整个凭据文件；文件不存在返回 {}；JSON 损坏显式报错（不静默当空）。 */
export async function readCredentials(dataDir: string): Promise<Record<string, unknown>> {
  const file = credentialsPath(dataDir)
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new CliError(
      `读取凭据文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CliError(
      `凭据文件损坏（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`凭据文件形状非法（${file}）：顶层必须是对象`, 'credentials_unreadable')
  }
  return { ...(parsed as Record<string, unknown>) }
}

/** 提取并校验 `cli` 键。 */
export function cliCredentialOf(raw: Record<string, unknown>): CliCredential {
  const cli = raw['cli']
  if (cli === undefined) return {} as CliCredential
  if (cli === null || typeof cli !== 'object' || Array.isArray(cli)) {
    throw new CliError('凭据文件 cli 键形状非法：必须是对象', 'credentials_unreadable')
  }
  const record = cli as Record<string, unknown>
  const hubUrl = record['hubUrl']
  const token = record['token']
  if (hubUrl !== undefined && typeof hubUrl !== 'string') {
    throw new CliError('凭据文件 cli.hubUrl 形状非法：必须是字符串', 'credentials_unreadable')
  }
  if (token !== undefined && typeof token !== 'string') {
    throw new CliError('凭据文件 cli.token 形状非法：必须是字符串', 'credentials_unreadable')
  }
  return { hubUrl, token }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 排他锁：O_EXCL 创建 credentials.json.lock（首字段 PID）。
 * 仅持有者 PID 确认死亡时破除 stale；不按存活时长强拆（合法持锁者可能只是慢）。
 * 返回释放函数（只移除自己持有的锁）。
 */
async function acquireCredentialsLock(lockFile: string): Promise<() => Promise<void>> {
  const owner = `${process.pid} ${randomUUID()}`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await fsp.writeFile(lockFile, `${owner}\n`, { flag: 'wx', mode: 0o600 })
      return async () => {
        try {
          const raw = await fsp.readFile(lockFile, 'utf8')
          if (raw.trim() === owner) await fsp.rm(lockFile, { force: true })
        } catch {
          /* 释放失败留给持有者死亡后的 stale 破除 */
        }
      }
    } catch (err) {
      if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST')) {
        throw new CliError(
          `无法创建凭据锁文件（${lockFile}）：${err instanceof Error ? err.message : String(err)}`,
          'credentials_lock_failed',
        )
      }
    }
    let stale = false
    let broken = false
    try {
      const raw = await fsp.readFile(lockFile, 'utf8')
      const head = raw.trim().split(/\s+/)[0] ?? ''
      if (!/^\d+$/.test(head)) {
        broken = true
      } else {
        const pid = Number(head)
        if (!isProcessAlive(pid)) stale = true
      }
    } catch {
      stale = true // 读失败 = 锁刚被释放：直接重试
    }
    if (broken) {
      throw new CliError(`凭据锁文件内容损坏（${lockFile}）：无法判定持有者`, 'credentials_lock_broken')
    }
    if (stale) {
      await fsp.rm(lockFile, { force: true }).catch(() => {})
      continue
    }
    if (Date.now() > deadline) {
      throw new CliError(`凭据文件被并发写入，等待锁超时（${lockFile}）`, 'credentials_lock_timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}

/** tmp（唯一 uuid 名）+ fsync + rename 原子写，恒 0600。 */
async function atomicWrite0600(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(tmp, 'w', 0o600)
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(tmp, file)
  } catch (err) {
    await handle?.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new CliError(
      `写入凭据文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_write_failed',
    )
  }
}

/** 持锁读-改-写 `cli` 键，保留其他键。 */
export async function updateCliCredentials(dataDir: string, cli: CliCredential): Promise<void> {
  // 先建 dataDir 再争锁：首启目录不存在时锁文件与凭据均无处落盘（ENOENT）
  await fsp.mkdir(dataDir, { recursive: true })
  const file = credentialsPath(dataDir)
  const unlock = await acquireCredentialsLock(`${file}.lock`)
  try {
    const current = await readCredentials(dataDir)
    const next: Record<string, unknown> = { ...current, cli }
    await atomicWrite0600(file, `${JSON.stringify(next, null, 2)}\n`)
    // 既有文件可能被外部放宽过权限：写路径同样收敛 0600，失败显式报错
    const st = await fsp.stat(file)
    if ((st.mode & 0o777) !== 0o600) {
      await fsp.chmod(file, 0o600).catch((err) => {
        throw new CliError(
          `凭据文件权限修复失败（应 0600）：${file}：${err instanceof Error ? err.message : String(err)}`,
          'credentials_write_failed',
        )
      })
    }
  } finally {
    await unlock()
  }
}
