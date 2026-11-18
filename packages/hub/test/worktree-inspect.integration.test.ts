/**
 * Integration tests for `builtin:workflow` read-only managed worktree inspection (`list_worktrees` /
 * `inspect_worktree` actions).
 *
 * Covers (via real `createHelm` + faux model + temp real Git repo + public plugin actions):
 * 1. Real `spawnAgent` with `isolation: 'worktree'` returns registered metadata in `list_worktrees`;
 * 2. `inspect_worktree` (exact `worktreeId`) runs real read-only git commands on the target node:
 *    uncommitted files, commits ahead of base, diff stat, and preview are all real values;
 * 3. Honest boundaries: unregistered path 404, mutually exclusive/empty selectors 400, cleaned-up
 *    record returns `unavailableReason = 'removed'` (metadata only, no git);
 * 4. `conversationId` selector locates the same record as `worktreeId`;
 * 5. Porcelain first-column preservation: staged/unstaged/untracked raw prefixes are never trimmed;
 * 6. Untracked-only files yield non-empty status with empty diff (`untracked` stays in status, not diff);
 * 7. Diffs exceeding 16 KiB are truncated to a real prefix (`diffTruncated = true`), and >200 dirty
 *    files preserve the true `dirtyFileCount`.
 *
 * Contract discipline: read-only inspection never mutates the worktree; everything runs against real
 * `createHelm` + `builtin:workflow` public actions without mocking git.
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }`.
 */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AgentExecutionInfo, AgentSpawnRequest } from '@helm/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HelmError } from '@helm/protocol'
import { extractWorkflowExecutionMeta } from '@helm/plugins/contracts'
import {
  createGitTemplate,
  createHubTestApp,
  type FauxProviderHandle,
  type GitTemplate,
  type HubTestApp,
} from './helpers/hub-test-env.js'

/** Extracts managed worktree metadata from execution info (namespaced by workflow). */
function worktreeOf(info: AgentExecutionInfo | undefined) {
  return info === undefined ? undefined : extractWorkflowExecutionMeta(info).worktree
}

/**
 * Platform fact: process occupancy scanning currently relies on Linux `/proc`. On non-Linux hosts,
 * cleanup rejects explicitly during process checks (`worktree_process_check_failed`) — tests branch
 * by platform rather than fabricating `complete = true` or skipping silently.
 */
const PROCESS_SCAN_ON = process.platform === 'linux'

let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-worktree-inspect-'))
  gitTemplate = createGitTemplate('helm-worktree-inspect-tpl-')
})

after(() => {
  gitTemplate?.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
})

interface RuntimeEnv {
  app: HubTestApp
  kernel: HubTestApp['kernel']
  faux: FauxProviderHandle
  invoke: {
    listWorktrees(): Promise<Array<Record<string, unknown>>>
    inspectWorktree(input: Record<string, unknown>): Promise<Record<string, unknown>>
    cleanupWorktree(input: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  close(): Promise<void>
}

async function openRuntime(dataDir: string, cwd: string): Promise<RuntimeEnv> {
  const { app, kernel, faux } = await createHubTestApp({
    dataDir,
    cwd,
  })
  return {
    app,
    kernel,
    faux,
    invoke: {
      listWorktrees: async (): Promise<Array<Record<string, unknown>>> => {
        const result = (await kernel.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as {
          worktrees: Array<Record<string, unknown>>
        }
        return result.worktrees
      },
      inspectWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:workflow', 'inspect_worktree', input) as never,
      cleanupWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:workflow', 'cleanup_worktree', input) as never,
    },
    async close() {
      await app.close().catch(() => {})
    },
  }
}

/** Spawns a clean isolated worktree with no tool calls (no leftover files, ideal for controlled setup). */
async function spawnCleanWorktree(env: RuntimeEnv): Promise<{ worktreeId: string; path: string; branch: string }> {
  let resolved: AgentExecutionInfo | undefined
  env.faux.setResponses([fauxAssistantMessage('directly complete, without tool invoke')])
  await env.kernel.spawnAgent({
    parentConversationId: 1,
    prompt: 'in isolated worktree execute task',
    isolation: 'worktree',
    onResolved: (info) => {
      resolved = info
    },
  } as AgentSpawnRequest)
  const worktree = worktreeOf(resolved)
  assert.ok(worktree?.id, 'should return managed worktree id')
  return {
    worktreeId: worktree!.id!,
    path: worktree!.path,
    branch: worktree!.branch,
  }
}

describe('builtin:workflow managed worktree read-only inspection actions', { timeout: 60_000 }, () => {
  it('lists real metadata after spawn and inspects real git state (dirty files, commits, diff)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd > .helm-child-pwd.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('task complete'),
      ])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'in isolated worktree execute task',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(worktreeOf(resolved)?.id, 'should return managed worktree id')
      const worktreeId = worktreeOf(resolved)!.id
      const path = worktreeOf(resolved)!.path
      const branch = worktreeOf(resolved)!.branch
      const childId = resolved!.conversationId!

      // ---- list_worktrees: complete metadata present immediately. ----
      const list = await env.invoke.listWorktrees()
      assert.ok(Array.isArray(list) && list.length === 1, `expected exactly 1 entry (got ${list.length})`)
      const record = list[0]! as Record<string, unknown>
      assert.equal(record['id'], worktreeId)
      assert.equal(record['path'], path)
      assert.equal(record['branch'], branch)
      assert.equal(record['nodeId'], 'local')
      assert.equal(record['status'], 'active')
      assert.equal(record['conversationId'], childId)

      // ---- Real changes in worktree: uncommitted file + one new commit. ----
      writeFileSync(join(path, 'draft.txt'), 'uncommitted draft\n')
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      writeFileSync(join(path, 'feature.txt'), 'committed change\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: one commit'])

      // ---- inspect_worktree (exact worktreeId). ----
      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect['exists'], true)
      assert.equal(inspect['unavailableReason'], undefined)
      assert.equal(inspect['currentBranch'], branch)
      assert.equal(inspect['branchChanged'], undefined, 'branchChanged must be omitted when current branch matches registered branch')
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(inspect['dirtyFileCount'], 2, 'two untracked files (draft.txt and .helm-child-pwd.txt); committed feature.txt is excluded')
      assert.ok(
        dirtyFiles.some((l) => l.includes('draft.txt')) && dirtyFiles.some((l) => l.includes('.helm-child-pwd.txt')),
        `dirtyFiles should list both untracked files (got ${JSON.stringify(dirtyFiles)})`,
      )
      assert.equal(inspect['commitsAhead'], 1, 'should be 1 commit ahead of registered baseCommit')
      assert.equal(inspect['unmergedCommits'], 1, 'should have 1 unmerged commit before merging into baseBranch/main')
      assert.equal(inspect['diffBase'], 'baseCommit')
      const diffStat = inspect['diffStat'] as string
      assert.ok(diffStat.includes('feature.txt'), `diffStat should include committed change (got ${diffStat})`)
      const diffPreview = inspect['diffPreview'] as string
      assert.ok(diffPreview.includes('+committed change'), 'diffPreview should include added line content')
      assert.equal(inspect['diffTruncated'], false)

      // ---- conversationId selector resolves the same record. ----
      const byConversation = await env.invoke.inspectWorktree({ conversationId: childId })
      assert.equal((byConversation['record'] as Record<string, unknown>)['id'], worktreeId)

      // ---- Read-only invariant: inspect causes no write side effects. ----
      assert.equal(existsSync(join(path, 'draft.txt')), true)
      assert.equal(existsSync(join(path, 'feature.txt')), true)

      // ---- Merge branch into main repo -> unmergedCommits drops to 0 while commitsAhead stays 1. ----
      execFileSync('git', ['merge', '--no-ff', branch, '-m', 'merge worker branch'], { cwd: repo, encoding: 'utf-8' })
      const afterMerge = await env.invoke.inspectWorktree({ worktreeId, diff: false })
      assert.equal(afterMerge['commitsAhead'], 1)
      assert.equal(afterMerge['unmergedCommits'], 0, 'merged branch must report unmergedCommits=0')
    } finally {
      await env.close()
    }
  })

  it('honest boundaries: unregistered path 404, mutually exclusive/empty selectors 400, cleaned-up record returns metadata only', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('directly complete, without tool invoke')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'in isolated worktree execute task',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      const worktreeId = worktreeOf(resolved)!.id

      // Unregistered path: 404 not_found (rejects arbitrary directories).
      await assert.rejects(
        () => env.invoke.inspectWorktree({ path: repo }),
        (err: unknown) => err instanceof Error && /\bnot_found\b|未找到路径/.test(err.message),
      )
      // Empty and mutually exclusive selectors: 400 validation_error.
      await assert.rejects(
        () => env.invoke.inspectWorktree({}),
        (err: unknown) => err instanceof Error && /需提供|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({ worktreeId, path: worktreeOf(resolved)!.path }),
        (err: unknown) => err instanceof Error && /互斥|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({ nodeId: 'local' }),
        (err: unknown) => err instanceof Error && /需提供|仅与 path 搭配|validation_error/.test(err.message),
      )

      // diff:false omits diff body while preserving stat and metadata.
      const noDiff = await env.invoke.inspectWorktree({ worktreeId, diff: false })
      assert.equal(noDiff['diffPreview'], undefined)

      // Inspect after cleanup (`force: true` for untracked gate artifact): metadata + removed.
      if (PROCESS_SCAN_ON) {
        await env.invoke.cleanupWorktree({ worktreeId, force: true })
      } else {
        await assert.rejects(
          () => env.invoke.cleanupWorktree({ worktreeId, force: true }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError)
            assert.equal(err.code, 'worktree_process_check_failed', 'non-Linux platforms do not support process scanning so cleanup must reject explicitly')
            return true
          },
        )
        await env.close()
        return
      }
      const after = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(after['exists'], false)
      assert.equal(after['unavailableReason'], 'removed')
      assert.equal((after['record'] as Record<string, unknown>)['status'], 'removed')
      assert.deepEqual(after['dirtyFiles'], [])
    } finally {
      await env.close()
    }
  })

  it('preserves porcelain first column for staged/unstaged/untracked files; diff covers tracked changes only', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })

      // Commit a tracked file first, then stage/modify/create untracked changes.
      writeFileSync(join(path, 'feature.txt'), 'v1\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: tracked file'])
      writeFileSync(join(path, 'feature.txt'), 'v2 unstaged body\n') // unstaged modification (leading space)
      writeFileSync(join(path, 'staged.txt'), 'staged new body\n')
      git(['add', 'staged.txt']) // staged addition (leading A)
      writeFileSync(join(path, 'README.md'), '# repo modified\n')
      git(['add', 'README.md']) // staged modification (leading M)
      writeFileSync(join(path, 'untracked.txt'), 'only untracked body\n')

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(inspect['dirtyFileCount'], 4)
      // Preserve raw XY columns and separator space without trimming.
      assert.ok(dirtyFiles.includes(' M feature.txt'), `unstaged leading space must be preserved (got ${JSON.stringify(dirtyFiles)})`)
      assert.ok(dirtyFiles.includes('A  staged.txt'), `staged addition leading A must be preserved (got ${JSON.stringify(dirtyFiles)})`)
      assert.ok(dirtyFiles.includes('M  README.md'), `staged modification leading M must be preserved (got ${JSON.stringify(dirtyFiles)})`)
      assert.ok(dirtyFiles.includes('?? untracked.txt'), `untracked ?? prefix must be preserved (got ${JSON.stringify(dirtyFiles)})`)
      assert.equal(inspect['dirtyFilesTruncated'], false)

      // Diff (against baseCommit) covers staged + unstaged tracked changes, excluding untracked files.
      const diffPreview = inspect['diffPreview'] as string
      assert.ok(diffPreview.includes('+v2 unstaged body'), 'diff should include unstaged modification')
      assert.ok(diffPreview.includes('+staged new body'), 'diff should include staged addition')
      assert.ok(!diffPreview.includes('untracked.txt'), 'untracked files must not appear in diff')
      const diffStat = inspect['diffStat'] as string
      assert.ok(diffStat.includes('feature.txt') && diffStat.includes('staged.txt'))
      assert.ok(!diffStat.includes('untracked.txt'), 'untracked files must not appear in diffStat')
      assert.equal(inspect['diffTruncated'], false)
    } finally {
      await env.close()
    }
  })

  it('untracked-only files yield non-empty status and empty diff', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't4')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      writeFileSync(join(path, 'untracked-only.txt'), 'only untracked\n')

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect['dirtyFileCount'], 1)
      assert.deepEqual(inspect['dirtyFiles'], ['?? untracked-only.txt'])
      // Contract: diffStat and diffPreview are undefined (not fabricated empty strings) when there are no tracked changes.
      assert.equal(inspect['diffStat'], undefined)
      assert.equal(inspect['diffPreview'], undefined)
      assert.equal(inspect['diffTruncated'], false)
    } finally {
      await env.close()
    }
  })

  it('truncates diffs over 16 KiB to a real prefix and preserves true dirtyFileCount over 200 files', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      // Single-file large tracked change (~33 KiB > 16 KiB preview cap).
      const bigBody = Array.from({ length: 480 }, (_, i) => `line-${String(i).padStart(3, '0')}-${'x'.repeat(60)}`).join('\n')
      writeFileSync(join(path, 'big-change.txt'), `${bigBody}\n`)
      git(['add', 'big-change.txt'])
      git(['commit', '-qm', 'feat: big change'])
      // 205 untracked files (exceeds 200-entry list cap while retaining accurate total count).
      for (let i = 0; i < 205; i++) {
        writeFileSync(join(path, `u-${String(i).padStart(3, '0')}.txt`), 'x\n')
      }

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      // Diff preview: truncated cleanly at the cap and matches the real diff prefix.
      assert.equal(inspect['diffTruncated'], true)
      const diffPreview = inspect['diffPreview'] as string
      assert.equal(diffPreview.length, 16_384, 'preview length should equal cap')
      const base = (inspect['record'] as Record<string, unknown>)['baseCommit'] as string
      const realDiff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', base], {
        cwd: path,
        encoding: 'utf-8',
      })
      assert.ok(realDiff.length > 16_384, 'precondition: real diff exceeds preview cap')
      assert.equal(diffPreview, realDiff.slice(0, 16_384), 'preview must match real diff prefix')
      // Status list: retains first 200 raw rows while total count remains 205.
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(dirtyFiles.length, 200)
      assert.equal(inspect['dirtyFileCount'], 205, 'dirtyFileCount must reflect true total despite truncation')
      assert.equal(inspect['dirtyFilesTruncated'], true)
      assert.ok(dirtyFiles[0]!.startsWith('?? u-'), 'retains raw porcelain row including ?? prefix')
      // diffStat stays below cap for single-file changes and must not carry a spurious truncation flag/note.
      const diffStat = inspect['diffStat'] as string
      assert.ok(!diffStat.includes('truncate'), `diffStat under cap must not include truncation note (got ${diffStat})`)
    } finally {
      await env.close()
    }
  })
})
