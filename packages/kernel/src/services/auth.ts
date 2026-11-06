/**
 * AuthService：单用户 scrypt 鉴权。
 * - setup 仅首次成功（已配置即拒绝），login 校验密码并签发随机 token；
 * - token 仅持久化 SHA-256 摘要，明文只在返回值中出现一次；
 * - createProcessToken 签发进程内受管 token：仅存内存摘要（同 dataDir 的
 *   实例共享注册表），verifyToken 识别，dispose 即失效，绝不落盘；
 * - 全部摘要比对使用 timingSafeEqual，密码长度 >= 8。
 * config.json 的并发更新经 ConfigService 串行化，保留其他模块写入的键。
 *
 * 并发互斥采用两级锁：setup/login 先持有按 dataDir 共享的 auth 操作锁
 * （跨 AuthService 实例互斥，并发 setup 仅一个成功），锁内再经
 * ConfigService.update 获取 config.json 文件锁。锁序恒为 auth → config，
 * 反向不存在，因此不会死锁；若直接复用 config.json 锁则会因同锁重入死锁。
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { ConfigService } from './config.js'
import { withFileLock } from './file-lock.js'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

export const MIN_PASSWORD_LENGTH = 8
const SCRYPT_KEYLEN = 64
const TOKEN_BYTES = 32

/** 持久化形态：密码盐+哈希与 token 摘要表，绝无明文。 */
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
    super('鉴权已配置，禁止重复 setup（如需重置请手动清理 config.json）')
    this.name = 'AuthAlreadyConfiguredError'
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('密码错误')
    this.name = 'InvalidCredentialsError'
  }
}

export class WeakPasswordError extends Error {
  constructor() {
    super(`密码长度至少 ${MIN_PASSWORD_LENGTH} 位`)
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
 * 进程内受管 token 注册表：dataDir → 摘要集合。仅内存（绝不持久化原文或
 * 摘要）；按 dataDir 共享使同进程内任意实例签发的受管 token 都能被验证方
 * （HTTP hub）识别——与持久化 token 的跨实例语义保持一致。
 */
const processTokenRegistry = new Map<string, Set<string>>()

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
  /** auth 操作锁 key：按 dataDir 共享（同一 dataDir 的全部实例互斥）。 */
  private readonly lockPath: string
  /** 进程内受管 token 注册表 key（与构造入参同形）。 */
  private readonly dataDir: string

  constructor(dataDir: string) {
    this.config = new ConfigService(dataDir)
    this.lockPath = join(dataDir, 'auth')
    this.dataDir = dataDir
  }

  private async readState(): Promise<AuthPersistedState | undefined> {
    const config = await this.config.get()
    const raw = config['auth']
    if (raw === undefined) return undefined
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('config.json 中 auth 字段结构非法')
    }
    const rec = raw as Record<string, unknown>
    const salt = rec['passwordSalt']
    const hash = rec['passwordHash']
    const tokens = rec['tokens']
    if (typeof salt !== 'string' || typeof hash !== 'string') {
      throw new Error('config.json 中 auth 字段结构非法（缺 salt/hash）')
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

  private async writeState(state: AuthPersistedState): Promise<void> {
    await this.config.update({ auth: state })
  }

  /** 是否已完成初始 setup。 */
  async status(): Promise<{ configured: boolean }> {
    const state = await this.readState()
    return { configured: state !== undefined }
  }

  /** 首次设置管理员密码并签发 token；已配置时显式拒绝（不静默改写）。 */
  async setup(password: string): Promise<{ token: string }> {
    assertPassword(password)
    // 跨实例串行化读改写：并发 setup 仅第一个成功，其余显式拒绝。
    return withFileLock(this.lockPath, async () => {
      const existing = await this.readState()
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

  /** 密码登录：校验通过签发新 token（旧 token 保留，支持多端在线）。 */
  async login(password: string): Promise<{ token: string }> {
    assertPassword(password)
    return withFileLock(this.lockPath, async () => {
      const state = await this.readState()
      if (state === undefined) {
        throw new Error('尚未完成 setup，请先执行初始化')
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
   * 签发进程内受管 token：仅存内存摘要，verifyToken 识别；dispose 后立即
   * 失效（幂等）。不写 config.json/SQLite，也不要求先完成 setup——内核受管
   * 子进程鉴权独立于密码体系。空串/任意匿名值永不被 verifyToken 放行。
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
   * 校验 token：先查进程内受管 token（仅内存，未 setup 也可用），再比对
   * 持久化摘要；全部恒时比较，不存在伪成功，匿名/空值永不放行。
   */
  async verifyToken(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token === '') return false
    const digest = sha256Hex(token)
    for (const stored of processTokenRegistry.get(this.dataDir) ?? []) {
      if (safeEqualHex(digest, stored)) return true
    }
    const state = await this.readState()
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
