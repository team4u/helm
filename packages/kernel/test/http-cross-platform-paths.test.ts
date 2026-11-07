/**
 * 跨平台绝对路径与通用运行时标识边界回归（HTTP + 服务层）。
 *
 * 覆盖：
 * 1. 会话 init/patch 的 cwd：POSIX `/`、Windows 盘符（`C:\\work` / `D:/repo`）与
 *    UNC（`\\\\srv\\share\\dir`）绝对路径放行；盘符相对（`C:relative`）与纯相对
 *    路径拒绝（对齐 runtime/tools.ts isAbsoluteTargetPath 语义，内核不依赖
 *    Hub 宿主平台规则判定远端/Windows 靶点路径形状）；
 * 2. Profile runtime.workspace 同一跨平台绝对路径校验（服务层 validateProfileInput
 *    与 HTTP parseProfileRuntime 双边界同规）；
 * 3. runtime.kind 零插件枚举硬编码：内核只校验外部运行时标识符格式
 *    （^[a-z][a-z0-9_-]{0,31}$），不点名任何插件——'herdr' / 'docker' 等
 *    一切合法标识放行，非法格式（大写、空串、特殊字符、超长）拒绝。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validateProfileInput } from '../src/services/profiles-skills.js'
import {
  parseConversationInit,
  parseConversationPatch,
  parseProfileBody,
  ValidationError,
} from '../src/http/validate.js'

const timeout = { timeout: 60_000 } as const

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-crosspath-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 会话 cwd 跨平台绝对路径（parseConversationInit / parseConversationPatch）
// ---------------------------------------------------------------------------

describe('会话 cwd 跨平台绝对路径校验', { timeout: 60_000 }, () => {
  const valid: Array<[string, string]> = [
    ['POSIX 根', '/'],
    ['POSIX 绝对', '/srv/work/helm'],
    ['Windows 盘符反斜杠', 'C:\\work\\helm'],
    ['Windows 盘符正斜杠', 'D:/repo/project'],
    ['小写盘符', 'c:\\Users\\dev'],
    ['UNC 路径', '\\\\srv\\share\\dir'],
  ]
  const invalid: Array<[string, string]> = [
    ['盘符相对（无分隔）', 'C:relative'],
    ['裸盘符', 'C:'],
    ['纯相对路径', 'work/dir'],
    ['空串（init 语义为未提供以外的非法值）', ''],
    ['单点相对', './x'],
    ['上跳相对', '../x'],
  ]

  for (const [why, cwd] of valid) {
    it(`init cwd 放行：${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const init = parseConversationInit({ cwd })
      assert.equal(init.cwd, cwd)
    })
    it(`patch cwd 放行：${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const patch = parseConversationPatch({ cwd })
      assert.equal(patch.cwd, cwd)
    })
  }

  for (const [why, cwd] of invalid) {
    it(`init cwd 拒绝：${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationInit({ cwd }), ValidationError)
    })
    it(`patch cwd 拒绝：${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationPatch({ cwd }), ValidationError)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Profile runtime.workspace 跨平台绝对路径（服务层 + HTTP 双边界）
// ---------------------------------------------------------------------------

describe('Profile runtime.workspace 跨平台绝对路径', { timeout: 60_000 }, () => {
  const validWorkspaces = [
    '/workspace/proj',
    'C:\\build\\helm',
    'D:/repo/project',
    '\\\\srv\\share\\work',
  ]
  const invalidWorkspaces = ['relative/ws', 'C:relative', '.', './x']

  for (const workspace of validWorkspaces) {
    it(`服务层放行 ${JSON.stringify(workspace)}`, timeout, () => {
      const profile = validateProfileInput({
        id: 'ws-ok',
        runtime: { kind: 'herdr', agent: 'agy', workspace },
      })
      assert.equal(profile.runtime?.workspace, workspace)
    })
    it(`HTTP 边界放行 ${JSON.stringify(workspace)}`, timeout, () => {
      const body = parseProfileBody(
        { id: 'ws-ok', runtime: { kind: 'herdr', agent: 'agy', workspace } },
        { requireId: true },
      )
      assert.equal(body.runtime?.workspace, workspace)
    })
  }

  for (const workspace of invalidWorkspaces) {
    it(`服务层拒绝 ${JSON.stringify(workspace)}`, timeout, () => {
      assert.throws(() =>
        validateProfileInput({
          id: 'ws-bad',
          runtime: { kind: 'herdr', agent: 'agy', workspace },
        }),
        /绝对路径/,
      )
    })
    it(`HTTP 边界拒绝 ${JSON.stringify(workspace)}`, timeout, () => {
      assert.throws(
        () =>
          parseProfileBody(
            { id: 'ws-bad', runtime: { kind: 'herdr', agent: 'agy', workspace } },
            { requireId: true },
          ),
        ValidationError,
      )
    })
  }
})

// ---------------------------------------------------------------------------
// 3. runtime.kind 零插件枚举硬编码（内核只校验标识符格式）
// ---------------------------------------------------------------------------

describe('runtime.kind 通用外部运行时标识校验（内核零插件枚举硬编码）', { timeout: 60_000 }, () => {
  const validKinds = ['herdr', 'docker', 'a', 'dev-box_runtime2']
  const invalidKinds = [
    // 内核不硬编码 'herdr'：测试拒绝的是非法格式本身，而非未知插件名。
    '',
    'Herdr',
    'HERDR',
    'Invalid Kind!',
    '1abc',
    '-lead',
    'a'.repeat(33),
  ]

  for (const kind of validKinds) {
    it(`服务层放行标识 ${JSON.stringify(kind)}`, timeout, () => {
      const profile = validateProfileInput({
        id: 'kind-ok',
        runtime: { kind, agent: 'agy' },
      })
      assert.equal(profile.runtime?.kind, kind)
    })
    it(`HTTP 边界放行标识 ${JSON.stringify(kind)}`, timeout, () => {
      const body = parseProfileBody(
        { id: 'kind-ok', runtime: { kind, agent: 'agy' } },
        { requireId: true },
      )
      assert.equal(body.runtime?.kind, kind)
    })
  }

  for (const kind of invalidKinds) {
    it(`服务层拒绝非法标识 ${JSON.stringify(kind)}`, timeout, () => {
      assert.throws(
        () =>
          validateProfileInput({
            id: 'kind-bad',
            runtime: { kind, agent: 'agy' },
          }),
        /外部运行时标识/,
      )
    })
    it(`HTTP 边界拒绝非法标识 ${JSON.stringify(kind)}`, timeout, () => {
      assert.throws(
        () =>
          parseProfileBody(
            { id: 'kind-bad', runtime: { kind, agent: 'agy' } },
            { requireId: true },
          ),
        ValidationError,
      )
    })
  }

  it('kind 非字符串（number/null）服务层拒绝', timeout, () => {
    assert.throws(() =>
      validateProfileInput({ id: 'kind-bad', runtime: { kind: 42, agent: 'agy' } as never }),
    )
  })
})

test('validateProfileInput 保留 ProfileRuntime 其余字段（agent/args/nodeId/env）', timeout, () => {
  const profile = validateProfileInput({
    id: 'full-rt',
    runtime: {
      kind: 'docker',
      agent: 'codex',
      args: ['--x'],
      nodeId: 'gpu-box',
      workspace: '/srv/ws',
      env: { A: '1' },
    },
  })
  assert.deepEqual(profile.runtime, {
    kind: 'docker',
    agent: 'codex',
    args: ['--x'],
    nodeId: 'gpu-box',
    workspace: '/srv/ws',
    env: { A: '1' },
  })
})
