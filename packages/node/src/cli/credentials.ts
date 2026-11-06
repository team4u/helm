/**
 * CLI 凭据：<dataDir>/credentials.json 的 `cli` 键（hubUrl + token），0600 原子写。
 * 该文件同时承载 Hub 的密钥等键——读-改-写必须持锁并保留其他键，绝不整体覆盖。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { CliError } from './errors.js'

export interface CliCredential {
  hubUrl?: string
  token?: string
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

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

/** 排他锁：O_EXCL 创建 + 陈旧检测打破；返回释放函数。 */
async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await fsp.writeFile(lockFile, `${process.pid} ${Date.now()}\n`, { flag: 'wx', mode: 0o600 })
      return async () => {
        await fsp.rm(lockFile, { force: true }).catch(() => {})
      }
    } catch (err) {
      if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST')) {
        throw new CliError(
          `无法创建凭据锁文件（${lockFile}）：${err instanceof Error ? err.message : String(err)}`,
          'credentials_lock_failed',
        )
      }
      try {
        const st = await fsp.stat(lockFile)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lockFile, { force: true })
          continue
        }
      } catch {
        /* 锁刚被释放：直接重试 */
      }
      if (Date.now() > deadline) {
        throw new CliError(`凭据文件被并发写入，等待锁超时（${lockFile}）`, 'credentials_lock_timeout')
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** tmp + rename 原子写，恒 0600。 */
async function atomicWrite0600(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    await fsp.writeFile(tmp, text, { mode: 0o600 })
    await fsp.chmod(tmp, 0o600)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new CliError(
      `写入凭据文件失败（${file}）：${err instanceof Error ? err.message : String(err)}`,
      'credentials_write_failed',
    )
  }
}

/** 持锁读-改-写 `cli` 键，保留其他键。 */
export async function updateCliCredentials(dataDir: string, cli: CliCredential): Promise<void> {
  const file = credentialsPath(dataDir)
  const unlock = await acquireLock(`${file}.cli.lock`)
  try {
    const current = await readCredentials(dataDir)
    const next: Record<string, unknown> = { ...current, cli }
    await atomicWrite0600(file, `${JSON.stringify(next, null, 2)}\n`)
  } finally {
    await unlock()
  }
}
