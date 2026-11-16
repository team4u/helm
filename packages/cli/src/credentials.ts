/**
 * CLI login state:<dataDir>/cli-token  0600 JSON { hubUrl, token }, this CLI dedicated belong.
 * credentials.json only bear load model/plugin secret key (archive @helm/kernel CredentialService),
 * CLI never read write it. write hold independent lock (cli-token.lock,tmp write full after fs.link atomic publish, first token segment
 * PID, only PID death break except stale; unsupported hard link connect file system retreat back O_EXCL + read side wide limit fall back)
 * + tmp atomic write.HELM_TOKEN environment variable takes precedence when on layer short route, do not trigger touch disk.
 * origin bind set:token only when target baseUrl and record hubUrl consistent when attach carries (see hub-client).
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
/** lock content empty/half truncate wide limit window: holder may correct where already create await write instant state, exceeds only then decide corrupt. */
const LOCK_SETTLE_GRACE_MS = 2_000
/** Windows on rename replace target by read way (kill toxic/index scan) short temporary occupy when has boundary backoff window and polling interval. */
const RENAME_BUSY_TOTAL_MS = 1_500
const RENAME_BUSY_POLL_MS = 25

export function dataDirFor(env: NodeJS.ProcessEnv): string {
  const v = env['HELM_DATA_DIR']
  if (v && v.trim()) return v.trim()
  return path.join(os.homedir(), '.helm')
}

/** CLI login state file (0600 JSON { hubUrl, token }). */
export function credentialsPath(dataDir: string): string {
  return path.join(dataDir, 'cli-token')
}

/** validate cli-token JSON shape; illegal/corrupt explicit errors (not silently when without credentials). */
function parseCliTokenFile(text: string, file: string): CliCredential {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(
      `CLI credentials file corrupt (${file}):${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`CLI credentials file shape illegal (${file}): top-level must be object`, 'credentials_unreadable')
  }
  const record = parsed as Record<string, unknown>
  if (record['hubUrl'] !== undefined && typeof record['hubUrl'] !== 'string') {
    throw new CliError('CLI credentials hubUrl shape illegal: must be string', 'credentials_unreadable')
  }
  if (record['token'] !== undefined && typeof record['token'] !== 'string') {
    throw new CliError('CLI credentials token shape illegal: must be string', 'credentials_unreadable')
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
 * arrange other lock: temp file write full content after fs.link atomic publish is cli-token.lock(first token segment PID).
 * link and open('wx') same tool atomic arrange other, but target one via visible i.e. contains complete content - - concurrency read way
 * absolute without window read to empty file or half truncate JSON. only holder PID confirm death when break except stale;
 * do not by store when long strong split (legal hold lock may only is slow). return release function (only remove itself hold has lock).
 */
async function acquireCliTokenLock(lockFile: string): Promise<() => Promise<void>> {
  const owner = `${process.pid} ${randomUUID()}`
  const deadline = Date.now() + LOCK_WAIT_MS
  const publish = async (): Promise<boolean> => {
    // tmp write full + flush, again link atomic publish;link failed (EEXIST=other person hold has;EXDEV/ENOSYS etc. by outside layer fall back)
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
        // special file system unsupported hard link connect: retreat back open('wx')(empty window by read side wide limit fall back, never static default mistakenly judge)
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
        `cannot create CLI credentials lock file (${lockFile}):${err instanceof Error ? err.message : String(err)}`,
        'credentials_lock_failed',
      )
    }
    if (held) {
      return async () => {
        try {
          const raw = await fsp.readFile(lockFile, 'utf8')
          if (raw.trim() === owner) await fsp.rm(lockFile, { force: true })
        } catch {
          /* release failed to holder death after stale break except */
        }
      }
    }
    let stale = false
    let pending = false
    try {
      const raw = await fsp.readFile(lockFile, 'utf8')
      const head = raw.trim().split(/\s+/)[0] ?? ''
      if (!/^\d+$/.test(head)) {
        // empty content/half truncate: old platform fallback or exception crash leftover. just create do not long treated as holder is now write,
        // wait for backoff after heavy read; exceeds wide limit window only then such as judge corrupt (not silently, also do not mistakenly kill concurrency).
        const stat = await fsp.stat(lockFile)
        if (Date.now() - stat.mtimeMs < LOCK_SETTLE_GRACE_MS) {
          pending = true
        } else {
          throw new CliError(
            `CLI credentials lock file content corrupt (${lockFile}): cannot decide holder`,
            'credentials_lock_broken',
          )
        }
      } else {
        const pid = Number(head)
        if (!isProcessAlive(pid)) stale = true
      }
    } catch (err) {
      if (err instanceof CliError) throw err
      // only ENOENT proxy table lock already release; permission and IO error cannot when act without lock, more cannot delete other person lock.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new CliError(
        `cannot read CLI credentials lock file (${lockFile}):${err instanceof Error ? err.message : String(err)}`,
        'credentials_lock_failed',
      )
    }
    if (stale) {
      await fsp.rm(lockFile, { force: true }).catch(() => {})
      continue
    }
    if (Date.now() > deadline) {
      throw new CliError(`CLI credentials by concurrency write, wait for lock timeout (${lockFile})`, 'credentials_lock_timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, pending ? LOCK_POLL_MS * 4 : LOCK_POLL_MS))
  }
}

/**
 * Windows instantaneous occupy decide: target by read/scan during rename will short temporary EPERM/EACCES/EBUSY,
 * backoff after retry i.e. can commit. other platform these code is real permission error, immediately failed does not without say wait for.
 */
function isTransientRenameBusy(err: unknown): boolean {
  if (process.platform !== 'win32') return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/** rename atomic replace; only Windows instantaneous occupy when has boundary backoff (total wait for about 1.5 second), exhausted still throw original error. */
async function renameAtomically(tmp: string, file: string): Promise<void> {
  const deadline = Date.now() + RENAME_BUSY_TOTAL_MS
  for (;;) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (err) {
      if (!isTransientRenameBusy(err) || Date.now() >= deadline) throw err
      await new Promise((resolve) => setTimeout(resolve, RENAME_BUSY_POLL_MS))
    }
  }
}

/** tmp(unique uuid name)+ fsync + rename atomic write, constant 0600;Windows instantaneous occupy backoff after still atomic commit. */
async function atomicWrite0600(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}`
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(tmp, 'w', 0o600)
    await handle.writeFile(text)
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameAtomically(tmp, file)
  } catch (err) {
    await handle?.close().catch(() => {})
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new CliError(
      `write CLI credentials file failed (${file}):${err instanceof Error ? err.message : String(err)}`,
      'credentials_write_failed',
    )
  }
}

/**
 * since has file may by external put wide permission: converge back 0600, failed explicit errors.
 * Windows without POSIX mode(NTFS away ACL,stat.mode do not express 0600), do not validate also do not
 * chmod(POSIX chmod in Windows on invalid); only non- Windows platform strictly converge.
 */
async function ensureMode0600(file: string): Promise<void> {
  if (process.platform === 'win32') return
  const st = await fsp.stat(file)
  if ((st.mode & 0o777) !== 0o600) {
    await fsp.chmod(file, 0o600).catch((err) => {
      throw new CliError(
        `CLI credentials file permission fix failed (should 0600):${file}:${err instanceof Error ? err.message : String(err)}`,
        'credentials_write_failed',
      )
    })
  }
}

/**
 * read CLI login state; file missing return empty credentials (not login). caller should first check
 * HELM_TOKEN short route (env takes precedence when do not read disk).
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
      `read CLI credentials file failed (${file}):${err instanceof Error ? err.message : String(err)}`,
      'credentials_unreadable',
    )
  }
  return parseCliTokenFile(raw, file)
}

/** write CLI login state: independent lock + atomic 0600 write.setup/login shared use. */
export async function updateCliCredentials(dataDir: string, cli: CliCredential): Promise<void> {
  // first create dataDir again contend lock: first start directory missing when lock file and credentials all without where (ENOENT)
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
