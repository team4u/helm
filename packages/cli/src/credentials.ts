/**
 * CLI 登录态：<dataDir>/cli-token 的 0600 JSON { hubUrl, token }，本 CLI 专属。
 * credentials.json 仅承载模型/插件密钥（归 @helm/kernel CredentialService），
 * CLI 绝不读写它。写入持独立锁（cli-token.lock，O_EXCL 创建、首字段 PID、
 * 仅 PID 死亡破除 stale）+ tmp 原子写。HELM_TOKEN 环境变量优先时上层短路，
 * 不触碰磁盘。
 * origin 绑定：token 仅当目标 baseUrl 与记录 hubUrl 一致时附带（见 hub-client）。
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

/** CLI 登录态文件（0600 JSON { hubUrl, token }）。 */
export function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'cli-token')
}

/** 校验 cli-token JSON 形状；非法/损坏显式报错（不静默当无凭据）。 */
function parseCliTokenFile(text: string, file: string): CliCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(
      `CLI 凭据文件损坏（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`CLI 凭据文件形状非法（${file}）：顶层必须是对象`, 'credentials_unreadable')
  }
  const record = parsed as Record<string, unknown>
  if (record['hubUrl'] !== undefined && typeof record['hubUrl'] !== 'string') {
    throw new CliError('CLI 凭据 hubUrl 形状非法：必须是字符串', 'credentials_unreadable')
  }
  if (record['token'] !== undefined && typeof record['token'] !== 'string') {
    throw new CliError('CLI 凭据 token 形状非法：必须是字符串', 'credentials_unreadable')
  }
  return { hubUrl: record['hubUrl'] as string | undefined, token: record['token'] as string | undefined }
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
 * 排他锁：O_EXCL 创建 cli-token.lock（首字段 PID）。
 * 仅持有者 PID 确认死亡时破除 stale；不按存活时长强拆（合法持锁者可能只是慢）。
 * 返回释放函数（只移除自己持有的锁）。
 */
async function acquireCliTokenLock(lockFile: string): Promise<() => Promise<void>> {
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
          `无法创建 CLI 凭据锁文件（${lockFile}）：${err instanceof Error ? err.message : String(err)}`,
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
      throw new CliError(`CLI 凭据锁文件内容损坏（${lockFile}）：无法判定持有者`, 'credentials_lock_broken')
    }
    if (stale) {
      await fsp.rm(lockFile, { force: true }).catch(() => {})
      continue
    }
    if (Date.now() > deadline) {
      throw new CliError(`CLI 凭据被并发写入，等待锁超时（${lockFile}）`, 'credentials_lock_timeout')
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
      `写入 CLI 凭据文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_write_failed',
    )
  }
}

/** 既有文件可能被外部放宽过权限：收敛回 0600，失败显式报错。 */
async function ensureMode0600(file: string): Promise<void> {
  const st = await fsp.stat(file)
  if ((st.mode & 0o777) !== 0o600) {
    await fsp.chmod(file, 0o600).catch((err) => {
      throw new CliError(
        `CLI 凭据文件权限修复失败（应 0600）：${file}：${err instanceof Error ? err.message : String(err)}`,
        'credentials_write_failed',
      )
    })
  }
}

/**
 * 读取 CLI 登录态；文件不存在返回空凭据（未登录）。调用方应先检查
 * HELM_TOKEN 短路（env 优先时不读磁盘）。
 */
export async function loadCliCredential(dataDir: string): Promise<CliCredential> {
  const file = credentialsPath(dataDir)
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {} as CliCredential
    }
    throw new CliError(
      `读取 CLI 凭据文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  return parseCliTokenFile(raw, file)
}

/** 写入 CLI 登录态：独立锁 + 原子 0600 写。setup/login 共用。 */
export async function updateCliCredentials(dataDir: string, cli: CliCredential): Promise<void> {
  // 先建 dataDir 再争锁：首启目录不存在时锁文件与凭据均无处落盘（ENOENT）
  await fsp.mkdir(dataDir, { recursive: true })
  const file = credentialsPath(dataDir)
  const unlock = await acquireCliTokenLock(`${file}.lock`)
  try {
    await atomicWrite0600(file, `${JSON.stringify(cli, null, 2)}\n`)
    await ensureMode0600(file)
  } finally {
    await unlock()
  }
}
