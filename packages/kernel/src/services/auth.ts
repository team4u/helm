/**
 * AuthService: single user scrypt authentication.
 * - setup only first time succeeded (already config i.e. reject),login validate password and sign random token;
 * - token only persist SHA-256 summary, plaintext only in return value in appear once;
 * - createProcessToken sign process inside managed token: only store memory summary (same dataDir 
 *   instance sharing register table),verifyToken identify,dispose i.e. expires, never;
 * - all summary than for use timingSafeEqual, password length >= 8.
 * config.json concurrency update via ConfigService serial, keep other module write key.
 *
 * concurrency mutual exclusion adopt two level lock:setup/login first hold has by dataDir sharing auth operation lock
 * (across AuthService instance mutual exclusion, concurrency setup only a succeeded), lock inside again via
 * ConfigService.update get config.json file lock. lock order constant is auth → config,
 * reverse missing, therefore will not deadlock; if directly re- use config.json lock then will because same lock heavy deadlock.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { HelmError } from '@helm/protocol'
import { ConfigService, onConfigInvalidated } from './config.js'
import { withFileLock } from './file-lock.js'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

export const MIN_PASSWORD_LENGTH = 8
const SCRYPT_KEYLEN = 64
const TOKEN_BYTES = 32

/** persist form: password salt+hash and token summary table, absolute without plaintext. */
interface AuthPersistedState {
  passwordSalt: string
  passwordHash: string
  tokens: Record<string, TokenRecord>
}

interface TokenRecord {
  digest: string
  createdAt: string
}

export class AuthAlreadyConfiguredError extends Error {
  constructor() {
    super('authentication already config, forbidden duplicate setup(such as must reset please manually clean up config.json)')
    this.name = 'AuthAlreadyConfiguredError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('password error')
    this.name = 'InvalidCredentialsError'
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`password length at least ${MIN_PASSWORD_LENGTH} `)
    this.name = 'WeakPasswordError'
  }
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError()
  }
}

async function hashPassword(password: string, salt: Buffer): Promise<string> {
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN)
  return derived.toString('hex')
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * process inside managed token register table:dataDir → summary set. only memory (never persist original text or
 * summary); by dataDir sharing make same process inside any instance sign managed token all can by verify way
 * (HTTP hub) identify - - and persist token across instance semantics stay consistent.
 */
const processTokenRegistry = new Map<string, Set<string>>()

interface AuthCacheEntry {
  generation: number
  state: AuthPersistedState | undefined
}

/**
 * process inside authentication snapshot cache and in-flight dedupe (key is ConfigService specification config.json path).
 * is what across instance sharing:HTTP middle piece high frequency invoke verifyToken/status, also run phase or test will
 * construct multiple AuthService(dataDir) instance; any one instance/module write or trigger expires when by
 * onConfigInvalidated unify clear, and in back fill when core for generation guard against concurrency old read back fill.
 */
const authStateCache = new Map<string, AuthCacheEntry>()
const inflightAuthReads = new Map<string, Promise<AuthPersistedState | undefined>>()

onConfigInvalidated((canonicalPath) => {
  authStateCache.delete(canonicalPath)
  inflightAuthReads.delete(canonicalPath)
})

function parseAuthState(config: Record<string, unknown>): AuthPersistedState | undefined {
  const raw = config['auth']
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('config.json in auth field structure illegal')
  }
  const rec = raw as Record<string, unknown>
  const salt = rec['passwordSalt']
  const hash = rec['passwordHash']
  const tokens = rec['tokens']
  if (typeof salt !== 'string' || typeof hash !== 'string') {
    throw new Error('config.json in auth field structure illegal (missing salt/hash)')
  }
  const tokenMap: Record<string, TokenRecord> = {}
  if (tokens !== undefined && typeof tokens === 'object' && tokens !== null) {
    for (const [key, value] of Object.entries(
      tokens as Record<string, unknown>,
    )) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>)['digest'] === 'string'
      ) {
        tokenMap[key] = {
          digest: (value as Record<string, unknown>)['digest'] as string,
          createdAt:
            typeof (value as Record<string, unknown>)['createdAt'] === 'string'
              ? ((value as Record<string, unknown>)['createdAt'] as string)
              : new Date().toISOString(),
        }
      }
    }
  }
  return { passwordSalt: salt, passwordHash: hash, tokens: tokenMap }
}

function processTokenDigests(dataDir: string): Set<string> {
  let digests = processTokenRegistry.get(dataDir)
  if (digests === undefined) {
    digests = new Set()
    processTokenRegistry.set(dataDir, digests)
  }
  return digests
}

export class AuthService {
  private readonly config: ConfigService
  /** auth operation lock key: by dataDir sharing (the same dataDir all instance mutual exclusion). */
  private readonly lockPath: string
  /** process inside managed token register table key(and construct reference same shape). */
  private readonly dataDir: string

  constructor(dataDir: string) {
    this.config = new ConfigService(dataDir)
    this.lockPath = join(dataDir, 'auth')
    this.dataDir = dataDir
  }

  private async readStateFromDisk(): Promise<AuthPersistedState | undefined> {
    const config = await this.config.get()
    return parseAuthState(config)
  }

  private async readStateCached(): Promise<AuthPersistedState | undefined> {
    const key = await this.config.getCanonicalPath()
    if (key === undefined) return this.readStateFromDisk()
    const currentGen = this.config.getGenerationSync(key)
    const cached = authStateCache.get(key)
    if (cached !== undefined && cached.generation === currentGen) {
      return cached.state
    }
    const existingInflight = inflightAuthReads.get(key)
    if (existingInflight !== undefined) {
      return existingInflight
    }
    const loadPromise = (async () => {
      const { config, generation, canonicalPath } = await this.config.getWithGeneration()
      const state = parseAuthState(config)
      // only in read during proxy count not push enter when back fill, guard against concurrency write after old read override cache.
      if (canonicalPath !== undefined && this.config.getGenerationSync(canonicalPath) === generation) {
        authStateCache.set(canonicalPath, { generation, state })
      }
      return state
    })()
    inflightAuthReads.set(key, loadPromise)
    try {
      return await loadPromise
    } finally {
      if (inflightAuthReads.get(key) === loadPromise) {
        inflightAuthReads.delete(key)
      }
    }
  }

  private async writeState(state: AuthPersistedState): Promise<void> {
    await this.config.update({ auth: state })
  }

  /** is otherwise completed initial setup. */
  async status(): Promise<{ configured: boolean }> {
    const state = await this.readStateCached()
    return { configured: state !== undefined }
  }

  /** first time settings manage member password and sign token; already config when explicit reject (not silently change write). */
  async setup(password: string): Promise<{ token: string }> {
    assertPassword(password)
    // across instance serial read change write: concurrency setup only a succeeded, the rest explicit reject.
    return withFileLock(this.lockPath, async () => {
      const existing = await this.readStateFromDisk()
      if (existing !== undefined) throw new AuthAlreadyConfiguredError()
      const salt = randomBytes(16)
      const passwordHash = await hashPassword(password, salt)
      const { token, record } = issueToken()
      await this.writeState({
        passwordSalt: salt.toString('hex'),
        passwordHash,
        tokens: { t1: record },
      })
      return { token }
    })
  }

  /** password login: validate via sign new token(old token keep, support many end online). */
  async login(password: string): Promise<{ token: string }> {
    assertPassword(password)
    return withFileLock(this.lockPath, async () => {
      const state = await this.readStateFromDisk()
      if (state === undefined) {
        // structure error code supply HTTP layer classify (for outside still mapping 409 not_setup).
        throw new HelmError('auth_not_setup', 'not yet complete setup, please first execute initialize', 409)
      }
      const derived = await hashPassword(
        password,
        Buffer.from(state.passwordSalt, 'hex'),
      )
      if (!safeEqualHex(derived, state.passwordHash)) {
        throw new InvalidCredentialsError()
      }
      const { token, record } = issueToken()
      const tokens = {
        ...state.tokens,
        [`t${Object.keys(state.tokens).length + 1}`]: record,
      }
      await this.writeState({ ...state, tokens })
      return { token }
    })
  }

  /**
   * sign process inside managed token: only store memory summary,verifyToken identify;dispose after immediately
   * expires (idempotent). do not write config.json/SQLite, also do not want seek first complete setup- - kernel managed
   * child process authentication independent at password body system. empty string/any anonymous value forever do not by verifyToken let through.
   */
  createProcessToken(): { token: string; dispose(): void } {
    const token = randomBytes(TOKEN_BYTES).toString('hex')
    const digest = sha256Hex(token)
    processTokenDigests(this.dataDir).add(digest)
    let disposed = false
    return {
      token,
      dispose: () => {
        if (disposed) return
        disposed = true
        const digests = processTokenRegistry.get(this.dataDir)
        digests?.delete(digest)
        if (digests?.size === 0) processTokenRegistry.delete(this.dataDir)
      },
    }
  }

  /**
   * validate token: first inspect process inside managed token(only memory, not setup also available), again than for
   * persist summary; all constant when compare, missing fake succeeded, anonymous/null value forever do not let through.
   */
  async verifyToken(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token === '') return false
    const digest = sha256Hex(token)
    for (const stored of processTokenRegistry.get(this.dataDir) ?? []) {
      if (safeEqualHex(digest, stored)) return true
    }
    const state = await this.readStateCached()
    if (state === undefined) return false
    for (const record of Object.values(state.tokens)) {
      if (safeEqualHex(digest, record.digest)) return true
    }
    return false
  }

}

function issueToken(): { token: string; record: TokenRecord } {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  return {
    token,
    record: { digest: sha256Hex(token), createdAt: new Date().toISOString() },
  }
}
