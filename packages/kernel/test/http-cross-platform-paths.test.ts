/**
 * across platform absolute path and through use runtime identifier boundary regression (HTTP + service layer).
 *
 * override:
 * 1. conversation init/patch  cwd:POSIX `/`,Windows symbol (`C:\\work` / `D:/repo`) and
 *    UNC(`\\\\srv\\share\\dir`) absolute path let through; symbol each other for (`C:relative`) and pure each other for
 *    path reject (align runtime/tools.ts isAbsoluteTargetPath semantics, kernel independent of
 *    Hub host platform rule decide remote/Windows target path shape);
 * 2. Profile runtime.workspace the same across platform absolute path validate (service layer validateProfileInput
 *    and HTTP parseProfileRuntime double boundary same rule);
 * 3. runtime.kind zero plugin enumeration hard encode: kernel only validate external runtime identifier symbol format
 *    (^[a-z][a-z0-9_-]{0,31}$), do not point name any plugin - -'herdr' / 'docker' etc.
 *    everything legal identifier let through, illegal format (large write, empty string, special character, over long) reject.
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
// 1. conversation cwd across platform absolute path (parseConversationInit / parseConversationPatch)
// ---------------------------------------------------------------------------

describe('conversation cwd across platform absolute path validate', { timeout: 60_000 }, () => {
  const valid: Array<[string, string]> = [
    ['POSIX ', '/'],
    ['POSIX absolute', '/srv/work/helm'],
    ['Windows symbol backslash', 'C:\\work\\helm'],
    ['Windows symbol correct slash', 'D:/repo/project'],
    ['small write symbol', 'c:\\Users\\dev'],
    ['UNC path', '\\\\srv\\share\\dir'],
  ]
  const invalid: Array<[string, string]> = [
    ['symbol each other for (without isolate)', 'C:relative'],
    ['bare symbol', 'C:'],
    ['pure relative path', 'work/dir'],
    ['empty string (init semantics is not provide with outside illegal value)', ''],
    ['single point each other for', './x'],
    ['on jump each other for', '../x'],
  ]

  for (const [why, cwd] of valid) {
    it(`init cwd let through:${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const init = parseConversationInit({ cwd })
      assert.equal(init.cwd, cwd)
    })
    it(`patch cwd let through:${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const patch = parseConversationPatch({ cwd })
      assert.equal(patch.cwd, cwd)
    })
  }

  for (const [why, cwd] of invalid) {
    it(`init cwd reject:${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationInit({ cwd }), ValidationError)
    })
    it(`patch cwd reject:${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationPatch({ cwd }), ValidationError)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Profile runtime.workspace across platform absolute path (service layer + HTTP double boundary)
// ---------------------------------------------------------------------------

describe('Profile runtime.workspace across platform absolute path', { timeout: 60_000 }, () => {
  const validWorkspaces = [
    '/workspace/proj',
    'C:\\build\\helm',
    'D:/repo/project',
    '\\\\srv\\share\\work',
  ]
  const invalidWorkspaces = ['relative/ws', 'C:relative', '.', './x']

  for (const workspace of validWorkspaces) {
    it(`service layer let through ${JSON.stringify(workspace)}`, timeout, () => {
      const profile = validateProfileInput({
        id: 'ws-ok',
        runtime: { kind: 'herdr', agent: 'agy', workspace },
      })
      assert.equal(profile.runtime?.workspace, workspace)
    })
    it(`HTTP boundary let through ${JSON.stringify(workspace)}`, timeout, () => {
      const body = parseProfileBody(
        { id: 'ws-ok', runtime: { kind: 'herdr', agent: 'agy', workspace } },
        { requireId: true },
      )
      assert.equal(body.runtime?.workspace, workspace)
    })
  }

  for (const workspace of invalidWorkspaces) {
    it(`service layer reject ${JSON.stringify(workspace)}`, timeout, () => {
      assert.throws(() =>
        validateProfileInput({
          id: 'ws-bad',
          runtime: { kind: 'herdr', agent: 'agy', workspace },
        }),
        /absolute path/,
      )
    })
    it(`HTTP boundary reject ${JSON.stringify(workspace)}`, timeout, () => {
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
// 3. runtime.kind zero plugin enumeration hard encode (kernel only validate identifier symbol format)
// ---------------------------------------------------------------------------

describe('runtime.kind through use external runtime identifier validate (kernel zero plugin enumeration hard encode)', { timeout: 60_000 }, () => {
  const validKinds = ['herdr', 'docker', 'a', 'dev-box_runtime2']
  const invalidKinds = [
    // kernel do not hard encode 'herdr': test reject is illegal format itself, while non- unknown plugin name.
    '',
    'Herdr',
    'HERDR',
    'Invalid Kind!',
    '1abc',
    '-lead',
    'a'.repeat(33),
  ]

  for (const kind of validKinds) {
    it(`service layer let through identifier ${JSON.stringify(kind)}`, timeout, () => {
      const profile = validateProfileInput({
        id: 'kind-ok',
        runtime: { kind, agent: 'agy' },
      })
      assert.equal(profile.runtime?.kind, kind)
    })
    it(`HTTP boundary let through identifier ${JSON.stringify(kind)}`, timeout, () => {
      const body = parseProfileBody(
        { id: 'kind-ok', runtime: { kind, agent: 'agy' } },
        { requireId: true },
      )
      assert.equal(body.runtime?.kind, kind)
    })
  }

  for (const kind of invalidKinds) {
    it(`service layer reject illegal identifier ${JSON.stringify(kind)}`, timeout, () => {
      assert.throws(
        () =>
          validateProfileInput({
            id: 'kind-bad',
            runtime: { kind, agent: 'agy' },
          }),
        /external runtime identifier/,
      )
    })
    it(`HTTP boundary reject illegal identifier ${JSON.stringify(kind)}`, timeout, () => {
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

  it('kind non- string (number/null) service layer reject', timeout, () => {
    assert.throws(() =>
      validateProfileInput({ id: 'kind-bad', runtime: { kind: 42, agent: 'agy' } as never }),
    )
  })
})

test('validateProfileInput keep ProfileRuntime the rest field (agent/args/nodeId/env)', timeout, () => {
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
