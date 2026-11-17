/**
 * Boundary regressions for cross-platform absolute paths and generic runtime identifiers (HTTP + service layers).
 *
 * Coverage:
 * 1. conversation init/patch cwd: allows POSIX `/`, Windows drive paths (`C:\\work` / `D:/repo`), and
 *    UNC paths (`\\\\srv\\share\\dir`); rejects drive-relative paths (`C:relative`) and pure relative
 *    paths (aligned with runtime/tools.ts isAbsoluteTargetPath semantics so kernel handles remote/Windows
 *    target path shapes independently of the Hub host OS);
 * 2. Profile runtime.workspace uses identical cross-platform absolute path validation (enforced consistently
 *    at both service layer validateProfileInput and HTTP layer parseProfileRuntime);
 * 3. runtime.kind has zero hardcoded plugin enums: kernel only validates external runtime identifier format
 *    (^[a-z][a-z0-9_-]{0,31}$) without special-casing plugin names -- valid identifiers like 'herdr' /
 *    'docker' pass, while invalid formats (uppercase, empty, special chars, oversized) reject.
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
// 1. Conversation cwd cross-platform absolute paths (parseConversationInit / parseConversationPatch)
// ---------------------------------------------------------------------------

describe('conversation cwd cross-platform absolute path validation', { timeout: 60_000 }, () => {
  const valid: Array<[string, string]> = [
    ['POSIX root', '/'],
    ['POSIX absolute', '/srv/work/helm'],
    ['Windows drive backslash', 'C:\\work\\helm'],
    ['Windows drive forward slash', 'D:/repo/project'],
    ['lowercase drive letter', 'c:\\Users\\dev'],
    ['UNC path', '\\\\srv\\share\\dir'],
  ]
  const invalid: Array<[string, string]> = [
    ['drive-relative (missing separator)', 'C:relative'],
    ['bare drive letter', 'C:'],
    ['pure relative path', 'work/dir'],
    ['empty string (invalid whenever explicitly provided outside init default)', ''],
    ['dot-relative', './x'],
    ['parent-relative', '../x'],
  ]

  for (const [why, cwd] of valid) {
    it(`init cwd allows ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const init = parseConversationInit({ cwd })
      assert.equal(init.cwd, cwd)
    })
    it(`patch cwd allows ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      const patch = parseConversationPatch({ cwd })
      assert.equal(patch.cwd, cwd)
    })
  }

  for (const [why, cwd] of invalid) {
    it(`init cwd rejects ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationInit({ cwd }), ValidationError)
    })
    it(`patch cwd rejects ${why} (${JSON.stringify(cwd)})`, timeout, () => {
      assert.throws(() => parseConversationPatch({ cwd }), ValidationError)
    })
  }
})

// ---------------------------------------------------------------------------
// 2. Profile runtime.workspace cross-platform absolute paths (service + HTTP layers)
// ---------------------------------------------------------------------------

describe('Profile runtime.workspace cross-platform absolute paths', { timeout: 60_000 }, () => {
  const validWorkspaces = [
    '/workspace/proj',
    'C:\\build\\helm',
    'D:/repo/project',
    '\\\\srv\\share\\work',
  ]
  const invalidWorkspaces = ['relative/ws', 'C:relative', '.', './x']

  for (const workspace of validWorkspaces) {
    it(`service layer allows ${JSON.stringify(workspace)}`, timeout, () => {
      const profile = validateProfileInput({
        id: 'ws-ok',
        runtime: { kind: 'herdr', agent: 'agy', workspace },
      })
      assert.equal(profile.runtime?.workspace, workspace)
    })
    it(`HTTP layer allows ${JSON.stringify(workspace)}`, timeout, () => {
      const body = parseProfileBody(
        { id: 'ws-ok', runtime: { kind: 'herdr', agent: 'agy', workspace } },
        { requireId: true },
      )
      assert.equal(body.runtime?.workspace, workspace)
    })
  }

  for (const workspace of invalidWorkspaces) {
    it(`service layer rejects ${JSON.stringify(workspace)}`, timeout, () => {
      assert.throws(() =>
        validateProfileInput({
          id: 'ws-bad',
          runtime: { kind: 'herdr', agent: 'agy', workspace },
        }),
        /absolute path/,
      )
    })
    it(`HTTP layer rejects ${JSON.stringify(workspace)}`, timeout, () => {
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
// 3. Generic runtime.kind validation (zero hardcoded plugin enums in kernel)
// ---------------------------------------------------------------------------

describe('runtime.kind generic external runtime identifier validation (no hardcoded plugin enums)', { timeout: 60_000 }, () => {
  const validKinds = ['herdr', 'docker', 'a', 'dev-box_runtime2']
  const invalidKinds = [
    // Kernel never hardcodes 'herdr': rejected strings fail syntax rules rather than plugin allowlists.
    '',
    'Herdr',
    'HERDR',
    'Invalid Kind!',
    '1abc',
    '-lead',
    'a'.repeat(33),
  ]

  for (const kind of validKinds) {
    it(`service layer allows identifier ${JSON.stringify(kind)}`, timeout, () => {
      const profile = validateProfileInput({
        id: 'kind-ok',
        runtime: { kind, agent: 'agy' },
      })
      assert.equal(profile.runtime?.kind, kind)
    })
    it(`HTTP layer allows identifier ${JSON.stringify(kind)}`, timeout, () => {
      const body = parseProfileBody(
        { id: 'kind-ok', runtime: { kind, agent: 'agy' } },
        { requireId: true },
      )
      assert.equal(body.runtime?.kind, kind)
    })
  }

  for (const kind of invalidKinds) {
    it(`service layer rejects invalid identifier ${JSON.stringify(kind)}`, timeout, () => {
      assert.throws(
        () =>
          validateProfileInput({
            id: 'kind-bad',
            runtime: { kind, agent: 'agy' },
          }),
        /external runtime identifier/,
      )
    })
    it(`HTTP layer rejects invalid identifier ${JSON.stringify(kind)}`, timeout, () => {
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

  it('service layer rejects non-string kind (number/null)', timeout, () => {
    assert.throws(() =>
      validateProfileInput({ id: 'kind-bad', runtime: { kind: 42, agent: 'agy' } as never }),
    )
  })
})

test('validateProfileInput preserves remaining ProfileRuntime fields (agent/args/nodeId/env)', timeout, () => {
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
