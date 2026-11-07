/**
 * CLI 登录态：<dataDir>/cli-token 的 0600 JSON { hubUrl, token }，本 CLI 专属。
 * credentials.json 仅承载模型/插件密钥（归 @helm/kernel CredentialService），
 * CLI 绝不读写它。写入持独立锁（cli-token.lock，tmp 写满后 fs.link 原子发布、首字段
 * PID、仅 PID 死亡破除 stale；不支持硬链接的文件系统退回 O_EXCL + 读取侧宽限兜底）
 * + tmp 原子写。HELM_TOKEN 环境变量优先时上层短路，不触碰磁盘。
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
/** 锁内容空/半截的宽限窗口：持有者可能正处「已创建待写入」的瞬态，超过才判定损坏。 */
const LOCK_SETTLE_GRACE_MS = 2_000

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
 * 排他锁：临时文件写满内容后 fs.link 原子发布为 cli-token.lock（首字段 PID）。
 * link 与 open('wx') 同具原子排他性，但目标一经可见即含完整内容——并发读取方
 * 绝无窗口读到空文件或半截 JSON。仅持有者 PID 确认死亡时破除 stale；
 * 不按存活时长强拆（合法持锁者可能只是慢）。返回释放函数（只移除自己持有的锁）。
 */
async function acquireCliTokenLock(lockFile: string): Promise<() => Promise<void>> {
  const owner = `${process.pid} ${randomUUID()}`
  const deadline = Date.now() + LOCK_WAIT_MS
  const publish = async (): Promise<boolean> => {
    // tmp 写满 + flush，再 link 原子发布；link 失败（EEXIST=他人持有；EXDEV/ENOSYS 等由外层兜底）
    const tmp = `${lockFile}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
    try {
      const handle = await fsp.open(tmp, 'w', 0o600)
      try {
        await handle.writeFile(`${owner}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fsp.link(tmp, lockFile)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      if (code === 'EXDEV' || code === 'ENOSYS' || code === 'EPERM' || code === 'EINVAL') {
        // 特殊文件系统不支持硬链接：退回 open('wx')（空窗由读取侧宽限兜底，绝不静默误判）
        try {
          await fsp.writeFile(lockFile, `${owner}\n`, { flag: 'wx', mode: 0o600 })
          return true
        } catch (fallbackErr) {
          if ((fallbackErr as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw fallbackErr
        }
      }
      throw err
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  }
  for (;;) {
    let held = false
    try {
      held = await publish()
    } catch (err) {
      throw new CliError(
        `无法创建 CLI 凭据锁文件（${lockFile}）：${err instanceof Error ? err.message : String(err)}`,
        'credentials_lock_failed',
      )
    }
    if (held) {
      return async () => {
        try {
          const raw = await fsp.readFile(lockFile, 'utf8')
          if (raw.trim() === owner) await fsp.rm(lockFile, { force: true })
        } catch {
          /* 释放失败留给持有者死亡后的 stale 破除 */
        }
      }
    }
    let stale = false
    let pending = false
    try {
      const raw = await fsp.readFile(lockFile, 'utf8')
      const head = raw.trim().split(/\s+/)[0] ?? ''
      if (!/^\d+$/.test(head)) {
        // 空内容/半截：旧平台 fallback 或异常崩溃残留。刚创建不久视为持有者正在写入，
        // 等待退避后重读；超过宽限窗才如实判损坏（不静默、也不误杀并发者）。
        const stat = await fsp.stat(lockFile)
        if (Date.now() - stat.mtimeMs < LOCK_SETTLE_GRACE_MS) {
          pending = true
        } else {
          throw new CliError(
            `CLI 凭据锁文件内容损坏（${lockFile}）：无法判定持有者`,
            'credentials_lock_broken',
          )
        }
      } else {
        const pid = Number(head)
        if (!isProcessAlive(pid)) stale = true
      }
    } catch (err) {
      if (err instanceof CliError) throw err
      stale = true // 读失败 = 锁刚被释放：直接重试
    }
    if (stale) {
      await fsp.rm(lockFile, { force: true }).catch(() => {})
      continue
    }
    if (Date.now() > deadline) {
      throw new CliError(`CLI 凭据被并发写入，等待锁超时（${lockFile}）`, 'credentials_lock_timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, pending ? LOCK_POLL_MS * 4 : LOCK_POLL_MS))
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
