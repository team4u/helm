import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withProcessFileLock } from '../src/services/file-lock.js'

test('锁路径不可读取时保留原始 IO 错误，不伪报等待超时或删除锁', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-file-lock-error-'))
  const target = join(dir, 'config.json')
  const lock = `${target}.lock`
  await mkdir(lock)
  let ran = false
  try {
    await assert.rejects(withProcessFileLock(target, async () => { ran = true }), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === 'EISDIR')
    assert.equal(ran, false)
    assert.equal((await stat(lock)).isDirectory(), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
