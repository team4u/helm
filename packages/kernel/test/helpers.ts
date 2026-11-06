/**
 * helm 内核服务测试基座：临时数据目录 + 共享断言工具。
 * 只依赖真实文件系统行为，不引入假 runtime。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** 每个测试组独立的临时数据目录（真实文件行为）。 */
export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'helm-services-test-'))
}

export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** 轮询等待条件成立（watcher 防抖 / 文件落盘等异步场景），超时即失败。 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await delay(intervalMs)
  }
}

export { assert }
