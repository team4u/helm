import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'

test('读取持有中的凭据锁遇到权限错误时显式失败，并保留锁与凭据', { timeout: 60_000 }, async (t) => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'helm-cli-lock-error-'))
  const lockPath = join(dir, 'cli-token.lock')
  const tokenPath = join(dir, 'cli-token')
  const owner = `${process.pid} existing-owner\n`
  await fsp.writeFile(lockPath, owner)
  await fsp.writeFile(tokenPath, 'original')
  const readFile = fsp.readFile.bind(fsp)
  const stub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    if (String(args[0]) === lockPath) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    return readFile(...args)
  })
  try {
    await assert.rejects(updateCliCredentials(dir, { token: 'replacement' }), (error: unknown) =>
      error instanceof CliError && error.code === 'credentials_lock_failed')
    stub.mock.restore()
    assert.equal(await readFile(lockPath, 'utf8'), owner)
    assert.equal(await readFile(tokenPath, 'utf8'), 'original')
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['cli-token', 'cli-token.lock'])
  } finally {
    stub.mock.restore()
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
