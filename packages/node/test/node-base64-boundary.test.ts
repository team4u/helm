import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createNodeEnvRpcServer } from '../src/daemon/env-rpc-server.js'

test('恰好 64MiB 的合法 base64 写入成功，编码膨胀和填充不减少字节额度', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-base64-boundary-'))
  const server = createNodeEnvRpcServer({ defaultCwd: dir })
  const size = 64 * 1024 * 1024
  const encodedLength = Math.ceil(size / 3) * 4
  try {
    // 全零数据的标准编码，末尾两个填充字符必须从解码长度中扣除。
    const result = await server.envWriteFile({ path: 'edge.bin', content: 'A'.repeat(encodedLength - 2) + '==', encoding: 'base64' })
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message)
    assert.equal((await stat(join(dir, 'edge.bin'))).size, size)
  } finally {
    await server.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
