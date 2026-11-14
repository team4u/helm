/**
 * worktree 清理进程占用保护集成测试（真实 git + 真实进程 + 真实 EnvFabric）。
 *
 * 覆盖：
 * - 真实子进程以 worktree 为 cwd → cleanup 显式 worktree_process_in_use
 *   （details 含 nodeId/path/PIDs/进程名/引用路径；不记录 cmdline/environ）；
 * - force: true 不可绕过进程占用检查（force 只授权丢弃文件）；
 * - 进程退出后 → cleanup 正常移除（保护不永久阻塞）；
 * - ignored 文件保护保持：.env 使非 force 清理仍 worktree_dirty（原有行为）；
 * - 探测失败（节点离线）→ worktree_process_check_failed（fail-closed，绝不
 *   假称 0 占用）；
 * - 快照不完整（complete=false）→ worktree_process_check_failed；
 * - 非 Linux Hub 平台（注入 hubPlatform）→ 显式拒绝（不伪造跨平台结果）；
 * - 本进程打开 worktree 内文件的 fd → fd 占用命中。
 *
 * 平台契约：本文件进程占用链路仅 Linux 实现；非 Linux 平台的既有 cleanup
 * 契约分叉见 native-worktree / worktree-runtime 集成测试（显式拒绝断言，
 * 不伪造 complete=true、不静默跳过）。
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError } from '@helm/protocol'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createEnvFabric } from '../src/env/fabric.js'
import { WorktreeAllocator } from '../src/builtin-plugins/workflow/worktree.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-wt-procusage-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 真实临时 Git 仓库。 */
function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@helm.local'])
  git(['config', 'user.name', 'helm-test'])
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  return dir
}

/** local 真实端口（与生产同契约）+ 指定 fabric 的进程占用探测。 */
function makeAllocator(fabric: ReturnType<typeof createEnvFabric>, docs: Map<string, unknown>): WorktreeAllocator {
  const envOf = (cwd: string) => new NodeExecutionEnv({ cwd })
  const docStore = {
    get<T>(key: string, initial: T): T {
      return (docs.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      docs.set(key, value)
    },
  }
  return new WorktreeAllocator({
    exec: (nodeId, cwd, args, options, context) =>
      envOf(cwd).exec([...args], options as never, context) as never,
    nodeExists: (nodeId, path, context) => envOf(path).exists(path, context) as never,
    nodeCanonicalPath: (nodeId, path, context) => envOf(path).canonicalPath(path, context) as never,
    inspectPathUsage: (nodeId, path, signal) => fabric.inspectPathUsage(nodeId, path, signal),
    docStore,
  })
}

/** 以 target 为 cwd 的长驻子进程（真实占用方）。 */
function holdProcess(target: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { cwd: target, stdio: 'ignore' })
  const pid = child.pid!
  return {
    pid,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill('SIGKILL')
      }),
  }
}

/**
 * 平台事实：进程占用扫描仅 Linux /proc。真实 /proc 用例按平台如实分叉：
 * 非 Linux 断言显式拒绝（不伪造 complete=true、不静默 skip）。
 */
const PROCESS_SCAN_ON = process.platform === 'linux'

/**
 * 断言真实探测的 cleanup 结算：Linux + 全可见（root）→ 正常移除；
 * Linux + 可见性不完整（非 root 环境）→ 显式 worktree_process_check_failed
 * 且携带诊断（fail-closed，不假设所有环境 root 全可见）。
 */
async function expectCleanupOkOrFailClosed(fn: () => Promise<{ removed: boolean }>): Promise<void> {
  try {
    const cleaned = await fn()
    assert.equal(cleaned.removed, true)
  } catch (error) {
    assert.ok(error instanceof HelmError, `应 HelmError（实得 ${String(error)}）`)
    assert.equal(
      error.code,
      'worktree_process_check_failed',
      `可见性不完整时只能 fail-closed（实得 ${error.code}：${error instanceof HelmError ? error.message : ''}）`,
    )
    const details = error.details as { diagnostics?: string[] }
    assert.ok((details?.diagnostics?.length ?? 0) > 0, 'fail-closed 必须携带不完整诊断')
  }
}

async function allocateCleanWorktree(name: string): Promise<{ repo: string; record: ReturnType<WorktreeAllocator['list']>[number]; allocator: WorktreeAllocator; fabric: ReturnType<typeof createEnvFabric>; docs: Map<string, unknown> }> {
  const repo = makeGitRepo(join(rootDir, name, 'repo'))
  const fabric = createEnvFabric({})
  const docs = new Map<string, unknown>()
  const allocator = makeAllocator(fabric, docs)
  const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
  return { repo, record, allocator, fabric, docs }
}

describe('worktree 清理进程占用保护（真实进程 + 真实 git）', { timeout: 60_000 }, () => {
  it('子进程 cwd 占用：cleanup 显式 worktree_process_in_use（details 含 pid/进程名/引用路径；force 不可绕过）', { timeout: 60_000 }, async () => {
    const { record, allocator } = await allocateCleanWorktree('t1')
    if (!PROCESS_SCAN_ON) {
      // 非 Linux：扫描显式不支持 → cleanup fail-closed（不伪造占用事实）。
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_process_check_failed')
          return true
        },
      )
      return
    }
    const holder = holdProcess(record.path)
    try {
      for (const force of [false, true]) {
        await assert.rejects(
          () => allocator.cleanup({ worktreeId: record.id, ...(force ? { force: true } : {}) }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError, `force=${force} 应抛 HelmError`)
            assert.equal(err.code, 'worktree_process_in_use', `force=${force} 均不可绕过（实得 ${err.code}）`)
            const details = err.details as { pids?: number[]; processes?: Array<{ pid: number; name?: string; source: string; path: string }>; nodeId?: string; path?: string }
            assert.ok(details!.pids!.includes(holder.pid), `details.pids 应含占用进程 ${holder.pid}（实得 ${JSON.stringify(details!.pids)}）`)
            const hit = details!.processes!.find((p) => p.pid === holder.pid)
            assert.ok(hit, 'details.processes 应含占用明细')
            assert.equal(hit!.source, 'cwd')
            assert.equal(hit!.path, record.path)
            assert.equal(typeof hit!.name, 'string', '应含进程名（comm；不读 cmdline/environ）')
            assert.equal(details!.nodeId, 'local')
            assert.equal(details!.path, record.path)
            assert.ok(!err.message.includes('cmdline'), '错误消息不得携带命令行')
            return true
          },
        )
      }
      assert.ok(existsSync(record.path), '拒绝清理时目录不得被移除')
    } finally {
      await holder.stop()
    }
    // 进程退出 → 保护解除；全可见环境正常清理，可见性不完整环境 fail-closed。
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }))
  })

  it('本进程打开 worktree 内文件的 fd：fd 占用命中；关闭 fd 后可清理', { timeout: 60_000 }, async () => {
    const { record, allocator } = await allocateCleanWorktree('t2')
    if (!PROCESS_SCAN_ON) {
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_process_check_failed')
          return true
        },
      )
      return
    }
    const held = join(record.path, 'held.log')
    writeFileSync(held, 'x')
    const fd = openSync(held, 'r')
    try {
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_process_in_use')
          const details = err.details as { processes?: Array<{ pid: number; source: string }> }
          const hit = details!.processes!.find((p) => p.pid === process.pid && p.source === 'fd')
          assert.ok(hit, `应命中本进程 fd：${JSON.stringify(details!.processes!.filter((p) => p.pid === process.pid))}`)
          return true
        },
      )
    } finally {
      closeSync(fd)
    }
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, force: true }))
  })

  it('ignored 文件保护保持：.env 使非 force 清理仍 worktree_dirty（进程检查不削弱脏保护）', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't3', 'repo'))
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'ignore env'], { cwd: repo })
    const fabric = createEnvFabric({})
    const docs = new Map<string, unknown>()
    const allocator = makeAllocator(fabric, docs)
    const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
    writeFileSync(join(record.path, '.env'), 'SECRET=1\n')
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'worktree_dirty', 'ignored 文件保护必须保持（先于进程检查的脏保护不被削弱）')
        return true
      },
    )
    // 无进程占用时 force 越过脏保护、通过进程检查 → 全可见环境正常移除；
    // 可见性不完整环境 fail-closed（expectCleanupOkOrFailClosed）。
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id, force: true }))
  })

  it('探测端口失败（节点离线）：worktree_process_check_failed（fail-closed，force 也不绕过）', { timeout: 60_000 }, async () => {
    const { record, allocator } = await allocateCleanWorktree('t4')
    // 直接对 allocator 注入离线探测（远程节点离线在 fabric 层即抛 node_offline，
    // allocator 将其映射为 worktree_process_check_failed；此处用假 fabric 同构验证）。
    const brokenFabric = createEnvFabric({})
    const docs = new Map<string, unknown>([
      ['runtime/worktrees', { version: 1, records: [record] }],
    ])
    const broken = new WorktreeAllocator({
      exec: (nodeId, cwd, args, options, context) =>
        new NodeExecutionEnv({ cwd }).exec([...args], options as never, context) as never,
      nodeExists: (nodeId, path, context) => new NodeExecutionEnv({ cwd: path }).exists(path, context) as never,
      nodeCanonicalPath: (nodeId, path, context) => new NodeExecutionEnv({ cwd: path }).canonicalPath(path, context) as never,
      inspectPathUsage: async () => {
        throw new HelmError('node_offline', '节点 remote-x 离线，无法建立 IPC 通道', 409)
      },
      docStore: {
        get<T>(key: string, initial: T): T {
          return (docs.get(key) as T | undefined) ?? initial
        },
        set<T>(key: string, value: T): void {
          docs.set(key, value)
        },
      },
    })
    void brokenFabric
    await assert.rejects(
      () => broken.cleanup({ worktreeId: record.id, force: true }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'worktree_process_check_failed', '无法证明 0 占用时必须显式失败（不假称干净）')
        const details = err.details as { cause?: string }
        assert.ok(details!.cause!.includes('node_offline'), `诊断应含真实原因（实得 ${details!.cause}）`)
        return true
      },
    )
    assert.ok(existsSync(record.path), 'fail-closed 时目录不得被移除')
    // 原 allocator（健康探测）仍可清理（全可见）或 fail-closed（可见性不完整）。
    await expectCleanupOkOrFailClosed(() => allocator.cleanup({ worktreeId: record.id }))
  })

  it('快照不完整（complete=false）：worktree_process_check_failed 并携带 diagnostics', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't5', 'repo'))
    const docs = new Map<string, unknown>()
    const record = await (async () => {
      const fabric = createEnvFabric({})
      const allocator = makeAllocator(fabric, docs)
      return allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
    })()
    const incomplete = new WorktreeAllocator({
      exec: (nodeId, cwd, args, options, context) =>
        new NodeExecutionEnv({ cwd }).exec([...args], options as never, context) as never,
      nodeExists: (nodeId, path, context) => new NodeExecutionEnv({ cwd: path }).exists(path, context) as never,
      nodeCanonicalPath: (nodeId, path, context) => new NodeExecutionEnv({ cwd: path }).canonicalPath(path, context) as never,
      inspectPathUsage: async (_nodeId, path) => ({
        path,
        processes: [],
        matchedTotal: 0,
        processesTruncated: false,
        complete: false,
        diagnostics: ['pid 999 (uid 0): 无权读取 cwd（EACCES），该进程占用情况未知'],
      }),
      docStore: {
        get<T>(key: string, initial: T): T {
          return (docs.get(key) as T | undefined) ?? initial
        },
        set<T>(key: string, value: T): void {
          docs.set(key, value)
        },
      },
    })
    await assert.rejects(
      () => incomplete.cleanup({ worktreeId: record.id, force: true }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'worktree_process_check_failed', '不完整快照绝不能当 0 占用')
        const details = err.details as { diagnostics?: string[] }
        assert.ok(details!.diagnostics!.some((d) => d.includes('pid 999')), 'diagnostics 应如实携带')
        return true
      },
    )
    assert.ok(existsSync(record.path))
    // 用真实完整探测的 allocator 清理（全可见正常 / 可见性不完整 fail-closed）。
    const fabric = createEnvFabric({})
    const healthy = makeAllocator(fabric, docs)
    await expectCleanupOkOrFailClosed(() => healthy.cleanup({ worktreeId: record.id }))
  })

  it('非 Linux Hub 平台（注入 hubPlatform=win32）：fabric 显式 not_supported → cleanup fail-closed', { timeout: 60_000 }, async () => {
    const repo = makeGitRepo(join(rootDir, 't6', 'repo'))
    const fabric = createEnvFabric({ hubPlatform: () => 'win32' })
    const docs = new Map<string, unknown>()
    const allocator = makeAllocator(fabric, docs)
    const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
    await assert.rejects(
      () => fabric.inspectPathUsage('local', record.path),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'path_usage_not_supported')
        assert.ok(err.message.includes('win32'), '错误应明示平台事实')
        return true
      },
    )
    await assert.rejects(
      () => allocator.cleanup({ worktreeId: record.id, force: true }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'worktree_process_check_failed', '非 Linux 平台：不伪造 0 占用，显式拒绝清理')
        return true
      },
    )
    assert.ok(existsSync(record.path), '拒绝时目录不得被移除')
    await assert.rejects(
      () => fabric.inspectPathUsage('local', 'C:\\workspace\\repo'),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'path_usage_not_supported', '合法 Windows 路径应明确报告平台不支持')
        return true
      },
    )
  })

  it('fabric 入参校验：相对路径 / NUL 拒绝（validation_error）；远程未知节点离线显式 node_offline', { timeout: 60_000 }, async () => {
    const fabric = createEnvFabric({})
    await assert.rejects(
      () => fabric.inspectPathUsage('local', 'relative/x'),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'validation_error')
        return true
      },
    )
    await assert.rejects(
      () => fabric.inspectPathUsage('local', '/a\u0000b'),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'validation_error')
        return true
      },
    )
    await assert.rejects(
      () => fabric.inspectPathUsage('node-nope', '/wt'),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'node_offline', '未知/离线节点显式失败，绝不回退本机')
        return true
      },
    )
  })
})

void BACKGROUND_CONTEXT
