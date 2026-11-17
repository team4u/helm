/**
 * AuthService: single-user scrypt authentication.
 * - `setup` succeeds only once (rejects if already configured); `login` verifies password and issues a random token;
 * - Persists only SHA-256 token digests; plaintext tokens appear only once in return values;
 * - `createProcessToken` issues in-process managed tokens: only in-memory digests (shared per `dataDir`),
 *   recognized by `verifyToken`, immediately invalidated on `dispose`, never written to disk;
 * - All digest comparisons use `timingSafeEqual`; password length >= 8.
 * Concurrent `config.json` updates are serialized via `ConfigService` to preserve keys owned by other modules.
 *
 * Concurrency mutex uses a two-level lock: `setup`/`login` acquire a `dataDir`-shared auth operation lock
 * first (serializing across AuthService instances so concurrent setups succeed only once), then acquire
 * the `config.json` file lock via `ConfigService.update`. Lock ordering is always `auth -> config`, never
 * reversed, preventing deadlocks that would happen if `setup`/`login` reused the `config.json` lock directly.
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

/** Persisted format: password salt + hash and token digest map, never plaintext. */
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
    super('authentication is already configured; duplicate setup is forbidden (clean up config.json manually to reset)')
    this.name = 'AuthAlreadyConfiguredError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('invalid password')
    this.name = 'InvalidCredentialsError'
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
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
 * Process-wide registry of managed tokens: `dataDir -> digest Set`. In-memory only (never persisted);
 * sharing by `dataDir` allows tokens issued by any instance in the same process to be recognized by
 * verifiers (HTTP hub), keeping cross-instance semantics consistent with persisted tokens.
 */
const processTokenRegistry = new Map<string, Set<string>>()

interface AuthCacheEntry {
  generation: number
  state: AuthPersistedState | undefined
}

/**
 * In-process auth snapshot cache and in-flight read deduplication (keyed by canonical `config.json` path).
 * Shared across instances because HTTP middleware calls `verifyToken`/`status` at high frequency and runtime/tests
 * instantiate multiple `AuthService(dataDir)` objects; cleared uniformly via `onConfigInvalidated` on writes
 * or invalidations, with `generation` guarding against stale reads repopulating the cache concurrently.
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
    throw new Error('invalid auth field structure in config.json')
  }
  const rec = raw as Record<string, unknown>
  const salt = rec['passwordSalt']
  const hash = rec['passwordHash']
  const tokens = rec['tokens']
  if (typeof salt !== 'string' || typeof hash !== 'string') {
    throw new Error('invalid auth field structure in config.json (missing salt/hash)')
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
  /** Auth operation lock key: shared per `dataDir` (mutually exclusive across all instances for the same `dataDir`). */
  private readonly lockPath: string
  /** Registry key for in-process managed tokens (matches `dataDir` constructor argument). */
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
      // Populate cache only if generation did not advance during read (prevents stale reads overwriting concurrent writes).
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

  /** Whether initial setup has been completed. */
  async status(): Promise<{ configured: boolean }> {
    const state = await this.readStateCached()
    return { configured: state !== undefined }
  }

  /** Initial admin password setup and token issuance; rejects explicitly if already configured (never overwrites silently). */
  async setup(password: string): Promise<{ token: string }> {
    assertPassword(password)
    // Cross-instance serialized read-modify-write: only one concurrent setup succeeds; others reject explicitly.
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

  /** Password login: issues a new token after verification (retains older tokens for multi-client sessions). */
  async login(password: string): Promise<{ token: string }> {
    assertPassword(password)
    return withFileLock(this.lockPath, async () => {
      const state = await this.readStateFromDisk()
      if (state === undefined) {
        // Structured code lets HTTP layer classify (mapped externally to `409 not_setup`).
        throw new HelmError('auth_not_setup', 'authentication is not configured yet; run setup first', 409)
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
   * Issue an in-process managed token: stored only as an in-memory digest, recognized by `verifyToken`, and
   * invalidated immediately upon `dispose` (idempotent). Never writes to `config.json`/SQLite and does not
   * require prior setup—kernel-managed child-process auth is independent of the user password system.
   * Empty or anonymous tokens are never accepted by `verifyToken`.
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
   * Verify a token: checks in-memory process-managed tokens first (works before setup), then persisted digests;
   * uses constant-time comparison, never fakes success when unconfigured, and never accepts empty/nullish values.
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
