/**
 * builtin:workflow managed worktree only read inspect view integration test (list_worktrees /
 * inspect_worktree action).
 *
 * override (via real createHelm + faux model + temporary real Git repository + plugin public action):
 * 1. real spawnAgent isolation:'worktree' after list_worktrees return register metadata;
 * 2. inspect_worktree(worktreeId precise choose) in target node real execute git only read
 *    command: uncommitted file, lead first baseline commit,diff count and preview all is real value;
 * 3. boundary honest: not register path 404, choose mutual exclusion 400, already clean up record return
 *    unavailableReason=removed(only metadata, do not run git), zero choose 400;
 * 4. conversationId choose and worktreeId etc. price locate the same record;
 * 5. porcelain first column keep:staged/unstaged/untracked original row do not trim;
 * 6. only untracked file when status non-empty while diff is empty (contract:untracked see
 *    state manifest, does not enter diff);
 * 7. large diff over 16KiB cap by truncate (diffTruncated=true and is real diff prefix);
 *    dirty file over 200 row when dirtyFileCount keep real total count.
 *
 * contract discipline: only read inspect view never produce write side effect (inspect view before after worktree content do not change);
 * all via real createHelm + builtin:workflow public action verify, do not mock git.
 *
 * runner: tsx --test; each test explicit timeout: 60_000 guard against deadlock.
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

/** extract managed worktree description (execution meta  workflow naming empty between business value). */
function worktreeOf(info: AgentExecutionInfo | undefined) {
  return info === undefined ? undefined : extractWorkflowExecutionMeta(info).worktree
}

/**
 * platform fact: process occupy scan when before only Linux /proc. non- Linux on cleanup in process check where
 * explicit reject (worktree_process_check_failed) - - test contract by platform such as fork,
 * do not fabricate complete=true, not silently skip (across platform explicit reject is when before behavior restrict).
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

/** derive a without tool invoke clean isolated worktree(no residue file, convenient at precise construct state). */
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
  assert.ok(worktree?.id, 'should back pass managed worktree id')
  return {
    worktreeId: worktree!.id!,
    path: worktree!.path,
    branch: worktree!.branch,
  }
}

describe('builtin:workflow managed worktree only read inspect view action', { timeout: 60_000 }, () => {
  it('spawn after list register real metadata;inspect return real git only read probe (dirty file/commit/diff)', { timeout: 60_000 }, async () => {
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
      assert.ok(worktreeOf(resolved)?.id, 'should back pass managed worktree id')
      const worktreeId = worktreeOf(resolved)!.id
      const path = worktreeOf(resolved)!.path
      const branch = worktreeOf(resolved)!.branch
      const childId = resolved!.conversationId!

      // ---- list_worktrees: register metadata complete and creates new in before.----
      const list = await env.invoke.listWorktrees()
      assert.ok(Array.isArray(list) && list.length === 1, `should exactly a register (got ${list.length})`)
      const record = list[0]! as Record<string, unknown>
      assert.equal(record['id'], worktreeId)
      assert.equal(record['path'], path)
      assert.equal(record['branch'], branch)
      assert.equal(record['nodeId'], 'local')
      assert.equal(record['status'], 'active')
      assert.equal(record['conversationId'], childId)

      // ---- worktree inside real change: uncommitted file + a new commit.----
      writeFileSync(join(path, 'draft.txt'), 'uncommitted draft\n')
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      writeFileSync(join(path, 'feature.txt'), 'committed change\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: one commit'])

      // ---- inspect_worktree(worktreeId precise choose).----
      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect['exists'], true)
      assert.equal(inspect['unavailableReason'], undefined)
      assert.equal(inspect['currentBranch'], branch)
      assert.equal(inspect['branchChanged'], undefined, 'right threat branch and register consistent when must not placement branchChanged')
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(inspect['dirtyFileCount'], 2, 'draft.txt and .helm-child-pwd.txt two untracked file (feature.txt committed do not in uncommitted manifest)')
      assert.ok(
        dirtyFiles.some((l) => l.includes('draft.txt')) && dirtyFiles.some((l) => l.includes('.helm-child-pwd.txt')),
        `uncommitted manifest should contains two untracked file (got ${JSON.stringify(dirtyFiles)})`,
      )
      assert.equal(inspect['commitsAhead'], 1, 'each other for register baseCommit lead first 1 commit')
      assert.equal(inspect['diffBase'], 'baseCommit')
      const diffStat = inspect['diffStat'] as string
      assert.ok(diffStat.includes('feature.txt'), `diff count should contains committed change (got ${diffStat})`)
      const diffPreview = inspect['diffPreview'] as string
      assert.ok(diffPreview.includes('+committed change'), 'diff preview should contains new increase row content')
      assert.equal(inspect['diffTruncated'], false)

      // ---- conversationId choose locate the same record (etc. price entry).----
      const byConversation = await env.invoke.inspectWorktree({ conversationId: childId })
      assert.equal((byConversation['record'] as Record<string, unknown>)['id'], worktreeId)

      // ---- only read iron rule: inspect view produces no write side effect.----
      assert.equal(existsSync(join(path, 'draft.txt')), true)
      assert.equal(existsSync(join(path, 'feature.txt')), true)
    } finally {
      await env.close()
    }
  })

  it('boundary honest: not register path 404, choose mutual exclusion/zero choose 400, already clean up record only return metadata', { timeout: 60_000 }, async () => {
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

      // not register path:404 not_found(unsupported any directory).
      await assert.rejects(
        () => env.invoke.inspectWorktree({ path: repo }),
        (err: unknown) => err instanceof Error && /\bnot_found\b|未找到路径/.test(err.message),
      )
      // zero choose and choose mutual exclusion:400 validation_error.
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

      // diff:false omit diff body text (count and metadata still return).
      const noDiff = await env.invoke.inspectWorktree({ worktreeId, diff: false })
      assert.equal(noDiff['diffPreview'], undefined)

      // clean up (force: tree inside may still has uncommitted gate artifact) after inspect view: only metadata + removed.
      if (PROCESS_SCAN_ON) {
        await env.invoke.cleanupWorktree({ worktreeId, force: true })
      } else {
        await assert.rejects(
          () => env.invoke.cleanupWorktree({ worktreeId, force: true }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError)
            assert.equal(err.code, 'worktree_process_check_failed', 'non- Linux platform: process occupy scan unsupported,cleanup must explicit reject')
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

  it('porcelain first column keep: first commit tracked again staged/unstaged change, state original row do not trim;diff override tracked change and excludes untracked', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't3')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })

      // first commit tracked file, again construct staged/unstaged/untracked three class change.
      writeFileSync(join(path, 'feature.txt'), 'v1\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: tracked file'])
      writeFileSync(join(path, 'feature.txt'), 'v2 unstaged body\n') // unstaged modify (first column is empty format)
      writeFileSync(join(path, 'staged.txt'), 'staged new body\n')
      git(['add', 'staged.txt']) // staged new increase (first column A)
      writeFileSync(join(path, 'README.md'), '# repo modified\n')
      git(['add', 'README.md']) // staged modify (first column M)
      writeFileSync(join(path, 'untracked.txt'), 'only untracked body\n')

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(inspect['dirtyFileCount'], 4)
      // original row keep:XY first column and column between space absolute without trim.
      assert.ok(dirtyFiles.includes(' M feature.txt'), `unstaged first column space must keep (got ${JSON.stringify(dirtyFiles)})`)
      assert.ok(dirtyFiles.includes('A  staged.txt'), `staged new increase first column A must keep (got ${JSON.stringify(dirtyFiles)})`)
      assert.ok(dirtyFiles.includes('M  README.md'), `staged modify first column M must keep (got ${JSON.stringify(dirtyFiles)})`)
      assert.ok(dirtyFiles.includes('?? untracked.txt'), `untracked original row ?? must keep (got ${JSON.stringify(dirtyFiles)})`)
      assert.equal(inspect['dirtyFilesTruncated'], false)

      // diff(each other for baseCommit) override staged + unstaged  tracked change, excludes untracked.
      const diffPreview = inspect['diffPreview'] as string
      assert.ok(diffPreview.includes('+v2 unstaged body'), 'diff should contains unstaged modify content')
      assert.ok(diffPreview.includes('+staged new body'), 'diff should contains staged new increase content')
      assert.ok(!diffPreview.includes('untracked.txt'), 'untracked file must not enter diff')
      const diffStat = inspect['diffStat'] as string
      assert.ok(diffStat.includes('feature.txt') && diffStat.includes('staged.txt'))
      assert.ok(!diffStat.includes('untracked.txt'), 'untracked file must not enter diff count')
      assert.equal(inspect['diffTruncated'], false)
    } finally {
      await env.close()
    }
  })

  it('only untracked file:status non-empty while diff is empty (untracked see state manifest, does not enter diff contract)', {
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
      // contract: without tracked change when diff and count all is empty (undefined), while non- fabricate empty string.
      assert.equal(inspect['diffStat'], undefined)
      assert.equal(inspect['diffPreview'], undefined)
      assert.equal(inspect['diffTruncated'], false)
    } finally {
      await env.close()
    }
  })

  it('large diff over 16KiB truncate is real prefix; dirty file over 200 row keep real total count and truncate mark record', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5')
    const repo = gitTemplate.cloneTo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      // single file large change (about 33KiB > 16KiB preview cap) commit is tracked change.
      const bigBody = Array.from({ length: 480 }, (_, i) => `line-${String(i).padStart(3, '0')}-${'x'.repeat(60)}`).join('\n')
      writeFileSync(join(path, 'big-change.txt'), `${bigBody}\n`)
      git(['add', 'big-change.txt'])
      git(['commit', '-qm', 'feat: big change'])
      // 205 untracked file (exceeds 200 row keep cap, real counter must keep).
      for (let i = 0; i < 205; i++) {
        writeFileSync(join(path, `u-${String(i).padStart(3, '0')}.txt`), 'x\n')
      }

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      // diff preview: collect phase first to first truncate, exactly is cap character count and is real diff prefix.
      assert.equal(inspect['diffTruncated'], true)
      const diffPreview = inspect['diffPreview'] as string
      assert.equal(diffPreview.length, 16_384, 'preview should exactly is cap character count')
      const base = (inspect['record'] as Record<string, unknown>)['baseCommit'] as string
      const realDiff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', base], {
        cwd: path,
        encoding: 'utf-8',
      })
      assert.ok(realDiff.length > 16_384, 'test before mention: real diff exceeds preview cap')
      assert.equal(diffPreview, realDiff.slice(0, 16_384), 'preview must be real diff prefix')
      // state manifest: keep before 200 original row, real total count 205 do not lose true.
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(dirtyFiles.length, 200)
      assert.equal(inspect['dirtyFileCount'], 205, 'non-empty state row real total count must not because truncate lose true')
      assert.equal(inspect['dirtyFilesTruncated'], true)
      assert.ok(dirtyFiles[0]!.startsWith('?? u-'), 'keep original row (contains ?? first column)')
      // count not over cap (single file large change --stat very short): must not mistakenly mark truncate.
      const diffStat = inspect['diffStat'] as string
      assert.ok(!diffStat.includes('truncate'), `count not over cap when must not attach truncate note (got ${diffStat})`)
    } finally {
      await env.close()
    }
  })
})
