/**
 * Hub 产品层 Web 静态目录解析策略测试。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { resolveHubWebDistDir, resolveWebDistOption } from '../src/web-dist.js'
import { useTempDir } from './helpers/hub-test-env.js'

test('payload/repo 布局：hub/dist 与 hub/src 入口均探测同级 web/dist（含 index.html）', { timeout: 60_000 }, (t) => {
  const root = useTempDir(t, 'helm-webdist-')
  mkdirSync(join(root, 'hub', 'dist'), { recursive: true })
  mkdirSync(join(root, 'hub', 'src'), { recursive: true })
  mkdirSync(join(root, 'web', 'dist'), { recursive: true })
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html><div id="root"></div>')
  assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), join(root, 'web', 'dist'))
  assert.equal(resolveHubWebDistDir(join(root, 'hub', 'src')), join(root, 'web', 'dist'))
})

test('无 index.html 或无 web 目录：返回 undefined（纯 API，不伪装静态站）', { timeout: 60_000 }, (t) => {
  const root = useTempDir(t, 'helm-webdist-')
  mkdirSync(join(root, 'hub', 'dist'), { recursive: true })
  mkdirSync(join(root, 'web', 'dist'), { recursive: true })
  assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined)
  rmSync(join(root, 'web'), { recursive: true, force: true })
  assert.equal(resolveHubWebDistDir(join(root, 'hub', 'dist')), undefined)
})

test('默认目录探测遇 I/O 故障显式失败，不回退为纯 API', {
  timeout: 60_000,
  skip: process.platform === 'win32' ? '创建 symlink 需 Windows 开发者模式或管理员权限' : false,
}, (t) => {
  const root = useTempDir(t, 'helm-webdist-')
  mkdirSync(join(root, 'web', 'dist'), { recursive: true })
  symlinkSync('index.html', join(root, 'web', 'dist', 'index.html'))
  assert.throws(
    () => resolveHubWebDistDir(join(root, 'hub', 'dist')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ELOOP',
  )
})

test('HELM_WEB_DIST_DIR：显式目录优先，禁用字面量显式关闭，未设置走默认探测', { timeout: 60_000 }, (t) => {
  const root = useTempDir(t, 'helm-webdist-')
  mkdirSync(join(root, 'hub', 'dist'), { recursive: true })
  mkdirSync(join(root, 'web', 'dist'), { recursive: true })
  writeFileSync(join(root, 'web', 'dist', 'index.html'), '<!doctype html>')
  const entry = join(root, 'hub', 'dist')
  assert.deepEqual(resolveWebDistOption('/custom/dist', entry), { webDistDir: '/custom/dist' })
  assert.deepEqual(resolveWebDistOption('false', entry), { webDistDir: false })
  assert.deepEqual(resolveWebDistOption('0', entry), { webDistDir: false })
  assert.deepEqual(resolveWebDistOption('', entry), { webDistDir: false })
  assert.deepEqual(resolveWebDistOption(undefined, entry), { webDistDir: join(root, 'web', 'dist') })
})
