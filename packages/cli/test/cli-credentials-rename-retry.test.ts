/**
 * Windows rename 瞬时占用回归：杀毒/索引扫描读取 cli-token 期间，fs.rename 原子替换
 * 目标会短暂 EPERM/EACCES/EBUSY（CI 真实日志：并发登录第 3 轮 rename 报 EPERM）。
 * 验证：短暂失败后退避重试成功提交；持续失败时退避有界耗尽，旧凭据原样保留、tmp 清理、
 * 仍抛 credentials_write_failed（不删旧目标、不改非原子写）。
 * 模拟边界：t.mock.method 按次注入 errno（与凭据锁权限测试同一风格）；平台窗口用
 * Object.defineProperty 覆写 process.platform（Node 保证该属性 configurable），finally 恢复。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'

/** 构造带 errno code 的错误（模拟 Windows 目标被读取方占用时 OS 返回的失败）。 */
function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`模拟 Windows 瞬时占用（${code}）`), { code })
}

/** 覆写 process.platform 为 win32（触发生产代码的 Windows 退避分支），返回恢复函数。 */
function fakeWin32Platform(): () => void {
  const real = process.platform
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  return () => Object.defineProperty(process, 'platform', { value: real, configurable: true })
}

/** 写入完成后 dataDir 不得残留任何 tmp / lock 产物（凭据目录只留最终文件）。 */
async function assertNoWriteLeftovers(dir: string): Promise<void> {
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.tmp') || f.includes('.lock'))
  assert.deepEqual(leftovers, [])
}

test('Windows rename 瞬时占用（EPERM/EACCES 交替）后退避成功：提交新值、无 tmp 残留', { timeout: 60_000 }, async (t) => {
  const restorePlatform = fakeWin32Platform()
  const rename = fsp.rename.bind(fsp)
  let occupied = 0
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    // 前两次替换目标被读取方短暂占用（不同码模拟不同占用源），第三次让路后成功
    if (occupied < 2) {
      occupied += 1
      throw errnoError(occupied === 1 ? 'EPERM' : 'EACCES')
    }
    return rename(...args)
  })
  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-rename-retry-'))
    try {
      await fsp.writeFile(
        path.join(dir, 'cli-token'),
        JSON.stringify({ hubUrl: 'http://127.0.0.1:1', token: 'tok-old' }),
        { mode: 0o600 },
      )
      await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-new' })
      const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, string>
      assert.deepEqual(saved, { hubUrl: 'http://127.0.0.1:2', token: 'tok-new' })
      assert.equal(stub.mock.callCount(), 3, '瞬时占用应退避重试到第三次提交成功')
      await assertNoWriteLeftovers(dir)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    stub.mock.restore()
    restorePlatform()
  }
})

test('Windows rename 持续 EPERM：退避有界耗尽后仍抛 credentials_write_failed，旧值保留、tmp 清理', { timeout: 60_000 }, async (t) => {
  const restorePlatform = fakeWin32Platform()
  const stub = t.mock.method(fsp, 'rename', async (...args: Parameters<typeof fsp.rename>) => {
    void args
    throw errnoError('EPERM')
  })
  const startedAt = Date.now()
  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-rename-busy-'))
    try {
      const original = `${JSON.stringify({ hubUrl: 'http://127.0.0.1:1', token: 'tok-old' }, null, 2)}\n`
      await fsp.writeFile(path.join(dir, 'cli-token'), original, { mode: 0o600 })
      await assert.rejects(
        updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-new' }),
        (error: unknown) => error instanceof CliError && error.code === 'credentials_write_failed',
      )
      // 原子性：目标从未被触碰（旧登录态完好），失败的 tmp 已清理、锁已释放
      assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), original)
      await assertNoWriteLeftovers(dir)
      // 有界退避：约 1.5 秒量级耗尽后放弃（不立即放弃、也不无界挂起）
      const waited = Date.now() - startedAt
      assert.ok(waited >= 1_400, `应退避约 1.5s 再失败，实际 ${waited}ms`)
      assert.ok(waited < 10_000, `退避必须收敛在秒级，实际 ${waited}ms`)
      assert.ok(stub.mock.callCount() >= 20, `应持续重试直至耗尽，实际 ${stub.mock.callCount()} 次`)
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } finally {
    stub.mock.restore()
    restorePlatform()
  }
})
