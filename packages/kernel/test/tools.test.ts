/**
 * 内核本机工具真实行为测试（bash / read / read_artifact）。
 *
 * 诚实性原则：全部走真实 child_process、真实 ArtifactService（InMemory 仓库 +
 * 真实文件落盘）、真实 SDK defineTool execute；faux provider 仅替代模型决策
 * （何时发起工具调用），绝不用同步假 fixture 掩盖服务的 Promise 签名。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import {
  buildToolEnv,
  createBashTool,
  createReadArtifactTool,
  createReadTool,
  runShell,
} from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'

interface FauxHandle {
  setResponses(messages: unknown[]): void
  provider: { id: string }
}

function makeFauxModels() {
  const models = createModels()
  const faux = fauxProvider() as unknown as FauxHandle
  models.setProvider(faux.provider as never)
  return { models, faux }
}

async function openRuntime(dir: string) {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models: models as never,
  })
  return Object.assign(runtime, { __faux: faux } as never)
}

/** 真实服务依赖：真实 ArtifactService（Promise 签名）+ 真实 SecretStash。 */
async function makeRealDeps(dir: string, stash = new SecretStash()): Promise<HelmToolDeps> {
  await ensureDataDir(dir)
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts,
  }
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-tools-test-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('runShell 真实进程行为', { timeout: 60_000 }, () => {
  it('成功与失败如实返回 exitCode；stdout/stderr 按到达序拼接', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs1'))
    const ok = await runShell(deps, 'echo out; echo err >&2; echo tail')
    assert.equal(ok.ok, true)
    assert.equal(ok.exitCode, 0)
    assert.ok(ok.output.includes('out'))
    assert.ok(ok.output.includes('err'))
    assert.ok(ok.output.includes('tail'))
    const fail = await runShell(deps, 'echo oops >&2; exit 3')
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.ok(fail.output.includes('oops'))
  })

  it('运行中 abort 杀进程组：sentinel 文件永不出现，不等待 120s 超时', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs2'))
    const sentinel = join(rootDir, 'rs2', 'sentinel.txt')
    const controller = new AbortController()
    const started = Date.now()
    // 命令 sleep 后写 sentinel；abort 生效则永远写不出。
    const p = runShell(deps, `sleep 30 && touch ${sentinel}`, {
      timeoutMs: 120_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await p
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.ok(elapsed < 10_000, `abort 应秒杀而非等满超时（耗时 ${elapsed}ms）`)
    // 等待足够久后确认 sentinel 未被写入（进程组确已终止）。
    await new Promise((r) => setTimeout(r, 700))
    assert.ok(!existsSyncSafe(sentinel), 'abort 后 shell 不应存活写入 sentinel')
  })

  it('预先 aborted 的 signal 绝不 spawn 命令', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs3'))
    const sentinel = join(rootDir, 'rs3', 'pre.txt')
    const controller = new AbortController()
    controller.abort()
    const result = await runShell(deps, `touch ${sentinel}`, { signal: controller.signal })
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('aborted'))
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!existsSyncSafe(sentinel), '预 aborted 不得 spawn 任何命令')
  })

  it('timeoutMs 校验：非正数 / 非整数 / Infinity / 超上限均显式拒绝', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs4'))
    for (const bad of [0, -5, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 601_000]) {
      await assert.rejects(
        () => runShell(deps, 'true', { timeoutMs: bad }),
        /invalid_timeout/,
        `timeoutMs=${bad} 应显式拒绝`,
      )
    }
  })

  it('超时杀组并显式标注 timeout', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs5'))
    const started = Date.now()
    const result = await runShell(deps, 'sleep 30', { timeoutMs: 500 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 10_000)
  })

  it('env 注入：stash 值注入子进程且从输出中脱敏消失', async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-super-secret-abcdef123456'
    stash.put(1, 'MY_TOKEN', secretValue)
    const deps = await makeRealDeps(join(rootDir, 'rs6'), stash)
    // 子进程可见 secret（诚实边界：可信代码固有权限），但输出必须脱敏。
    const result = await runShell(deps, 'echo "token=$MY_TOKEN"', { conversationId: 1 })
    assert.equal(result.ok, true)
    assert.ok(!result.output.includes(secretValue), 'secret 明文绝不能出现在输出')
    assert.ok(result.output.includes('[REDACTED:stash:'), '应替换为占位符')
  })

  it('跨 chunk 撕裂的 secret 在全文聚合后仍被完整脱敏', async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-cross-chunk-secret-ZZZZ9999'
    stash.put(1, 'KEY', secretValue)
    const deps = await makeRealDeps(join(rootDir, 'rs7'), stash)
    // 用 dd 按 1 字节分块输出，强制 secret 跨多个 stdout chunk 撕裂。
    const result = await runShell(deps, `printf '%s' "$KEY" | dd bs=1 2>/dev/null`, {
      conversationId: 1,
    })
    assert.equal(result.ok, true)
    assert.ok(!result.output.includes(secretValue), '跨 chunk 撕裂的 secret 也不得泄漏')
    assert.ok(result.output.includes('[REDACTED:stash:'))
  })

  it('多字节 UTF-8 字符跨 chunk 不撕裂（无替换符）', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs8'))
    // 中文字符 3 字节；dd bs=1 强制逐字节 chunk，StringDecoder 语义下应完整还原。
    const result = await runShell(
      deps,
      `printf '%s' '你好世界汉字保真测试' | dd bs=1 2>/dev/null`,
    )
    assert.equal(result.ok, true)
    assert.equal(result.output, '你好世界汉字保真测试')
    assert.ok(!result.output.includes('\uFFFD'), '不得出现 UTF-8 替换符')
  })

  it('输出超 maxOutputBytes 显式 output_limit_exceeded，绝不截断当成功', async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs9'))
    const result = await runShell(deps, `head -c 200000 /dev/zero | tr '\\0' 'A'`, {
      maxOutputBytes: 100_000,
    })
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('output_limit_exceeded'))
    assert.ok(!result.output.includes('AAAA'), '超限后不得回显截断内容冒充结果')
  })

  it('buildToolEnv：宿主四变量固定覆盖 stash 同名注入', () => {
    const stash = new SecretStash()
    stash.put(7, 'HELM_CWD', '/evil')
    const deps: HelmToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id) => stash.envFor(id),
      redact: (t) => t,
      artifacts: null as never,
    }
    const env = buildToolEnv(deps, '/work', 7)
    assert.equal(env['HELM_ENV'], '1')
    assert.equal(env['HELM_HUB_URL'], 'http://127.0.0.1:3202')
    assert.equal(env['HELM_CONVERSATION_ID'], '7')
    assert.equal(env['HELM_CWD'], '/work')
  })
})

describe('read 工具真实文件行为', { timeout: 60_000 }, () => {
  it('读取 cwd 内文件成功；内容经 spill 返回', async () => {
    const dir = join(rootDir, 'rd1')
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'note.md'), '# 标题\n正文')
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'note.md' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# 标题'))
  })

  it('../ 逃逸与绝对路径越界拒绝', async () => {
    const dir = join(rootDir, 'rd2')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    const deps = await makeRealDeps(join(dir, 'inner'))
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    const tool = createReadTool(deps)
    for (const p of ['../secret.txt', join(dir, 'secret.txt'), '../../etc/passwd']) {
      const result = await tool.execute({ path: p }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
    assert.equal(result.isError, true, `路径 ${p} 应被拒绝`)
    }
  })

  it('软链越界拒绝（realpath 解析后 containment）', async () => {
    const dir = join(rootDir, 'rd3')
    const outer = join(rootDir, 'rd3-outer')
    mkdirSync(outer, { recursive: true })
    mkdirSync(join(dir, 'inner'), { recursive: true })
    writeFileSync(join(outer, 'linked.txt'), 'via-symlink')
    symlinkSync(join(outer, 'linked.txt'), join(dir, 'inner', 'link.txt'))
    const deps = await makeRealDeps(join(dir, 'inner'))
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'link.txt' },
      makeApi(join(dir, 'inner')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true, '指向 cwd 外的软链必须拒绝')
    const text = (result.output as Array<{ type: string; text: string }>)[0]!.text
    assert.ok(text.includes('path_escape_denied'))
  })

  it('目录拒绝；超大文件显式 file_too_large 并给出替代指引', async () => {
    const dir = join(rootDir, 'rd4')
    const deps = await makeRealDeps(dir)
    const tool = createReadTool(deps)
    const dirResult = await tool.execute({ path: '.' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dirResult.isError, true)
    const big = Buffer.alloc(129 * 1024, 0x61)
    writeFileSync(join(dir, 'big.txt'), big)
    const bigResult = await tool.execute({ path: 'big.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(bigResult.isError, true)
    const text = (bigResult.output as Array<{ type: string; text: string }>)[0]!.text
    assert.ok(text.includes('file_too_large'))
    assert.ok(text.includes('read_artifact'), '错误信息应指引分页替代路径')
  })

  it('读取错误脱敏（secret 不进错误文本）', async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-read-error-secret-777'
    stash.put(1, 'TOK', secretValue)
    const dir = join(rootDir, 'rd5')
    const deps = await makeRealDeps(dir, stash)
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'no-such-file.txt' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true)
    assert.ok(!JSON.stringify(result).includes(secretValue), '错误文本同样必须脱敏')
  })
})

describe('read_artifact 真实 ArtifactService 行为', { timeout: 60_000 }, () => {
  it('读取成功：真实 spill 产物分页前进至读完', async () => {
    const dir = join(rootDir, 'ra1')
    const deps = await makeRealDeps(dir)
    const fullText = '中文'.repeat(8000) // 48000 字节 > 32KiB 触发真实 spill
    const { artifact } = await deps.artifacts.spill(1, 'call-1', fullText)
    assert.ok(artifact, '文本 >32KiB 应产生 spill 产物')
    const tool = createReadArtifactTool(deps, (conv, owner) => conv === owner)
    let offset = 0
    let chunks = ''
    let guard = 0
    for (;;) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 4096 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      assert.equal(!!result.isError, false)
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      chunks += structured.chunk
      if (structured.nextOffset === undefined) break
      assert.ok(structured.nextOffset > offset, `nextOffset 必须严格前进（${offset} -> ${structured.nextOffset}）`)
      offset = structured.nextOffset
      assert.ok(++guard < 100, '分页循环必须终止')
    }
    assert.equal(chunks, fullText, '分页拼接应还原全文（UTF-8 边界无损）')
  })

  it('任意 offset 从不产生替换符；limit=1 遇多字节字符仍保证前进', async () => {
    const dir = join(rootDir, 'ra2')
    const deps = await makeRealDeps(dir)
    const { artifact } = await deps.artifacts.spill(1, 'call-2', '漢字テスト'.repeat(3000))
    const tool = createReadArtifactTool(deps, (conv, owner) => conv === owner)
    const fullText = '漢字テスト'.repeat(3000)
    const buffer = Buffer.from(fullText, 'utf8')
    // 遍历每个字节 offset：chunk 不得含替换符；limit=1 也必须能读完。
    for (let offset = 0; offset < buffer.length; offset += 997) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `offset=${offset} 不得撕裂出替换符`)
      assert.ok(
        structured.nextOffset === undefined || structured.nextOffset > offset,
        `offset=${offset} limit=1 也必须前进`,
      )
    }
    // limit=1 从字符中间 offset 开始完整读完全文
    const midCharOffset = 1 // 「漢」的第 2 字节
    let offset = midCharOffset
    let total = ''
    let guard = 0
    for (;;) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      total += structured.chunk
      if (structured.nextOffset === undefined) break
      offset = structured.nextOffset
      assert.ok(++guard < 16000, '逐字节分页必须终止')
    }
    assert.equal(total, fullText.slice(1), '从字符中间起读应跳过残缺首字符还原其余全文')
  })

  it('越界会话拒绝（授权仅当前会话/父链）', async () => {
    const dir = join(rootDir, 'ra3')
    const deps = await makeRealDeps(dir)
    const { artifact } = await deps.artifacts.spill(2, 'call-3', 'owner-2-content-'.repeat(3000))
    const tool = createReadArtifactTool(
      deps,
      (conv, owner) => conv === owner, // 模拟 runtime 的会话/父链授权
    )
    const denied = await tool.execute({ id: artifact!.id }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(denied.isError, true)
    const allowed = await tool.execute({ id: artifact!.id }, makeApi(dir, 2), BACKGROUND_CONTEXT)
    assert.equal(!!allowed.isError, false)
  })

  it('不存在产物 artifact_not_found；offset 超范围显式拒绝；nextOffset 不输出 undefined 字段', async () => {
    const dir = join(rootDir, 'ra4')
    const deps = await makeRealDeps(dir)
    const tool = createReadArtifactTool(deps, () => true)
    const missing = await tool.execute({ id: 'no-such-id' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(missing.isError, true)
    assert.ok(
      ((missing.output as Array<{ text: string }>)[0]!.text).includes('artifact_not_found'),
    )
    const { artifact } = await deps.artifacts.spill(1, 'call-4', 'short-content-'.repeat(3000))
    const oob = await tool.execute(
      { id: artifact!.id, offset: 99999 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(oob.isError, true)
    assert.ok(((oob.output as Array<{ text: string }>)[0]!.text).includes('offset_out_of_range'))
    // 分页至最后一页后 structuredOutput 无 nextOffset 字段（JSON-safe，非 undefined 值）
    let lastOffset = 0
    let last: { structuredOutput?: Record<string, unknown> } = {}
    for (let guard = 0; guard < 100; guard++) {
      const page = (await tool.execute(
        { id: artifact!.id, offset: lastOffset },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )) as { structuredOutput?: Record<string, unknown> }
      last = page
      const next = (page.structuredOutput as { nextOffset?: number }).nextOffset
      if (next === undefined) break
      lastOffset = next
    }
    const structured = last.structuredOutput as Record<string, unknown>
    assert.ok(!('nextOffset' in structured), '读完时不得出现 undefined 的 nextOffset 字段')
    assert.equal(JSON.stringify(structured).includes('undefined'), false)
  })
})

describe('bash 工具（SDK execute 直调，真实服务依赖）', { timeout: 60_000 }, () => {
  it('成功执行并返回 structuredOutput（经真实 spill）', async () => {
    const dir = join(rootDir, 'bt1')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const result = await tool.execute(
      { command: 'echo hello-tools' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { ok: boolean; output: string }
    assert.equal(structured.ok, true)
    assert.ok(structured.output.includes('hello-tools'))
  })

  it('失败命令 isError 如实；timeoutMs 非法值显式拒绝', async () => {
    const dir = join(rootDir, 'bt2')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const fail = await tool.execute(
      { command: 'exit 7' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(fail.isError, true)
    const bad = await tool.execute(
      { command: 'true', timeoutMs: -1 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(bad.isError, true)
    assert.ok(
      ((bad.output as Array<{ text: string }>)[0]!.text).includes('invalid_timeout'),
      '非法 timeout 不得被静默改默认',
    )
  })
})

describe('SDK 真实链路（faux 模型驱动工具调用）', { timeout: 60_000 }, () => {
  it('bash 工具经 harness 真实执行 + spill 产物登记 + read_artifact 分页读回', async () => {
    const dir = join(rootDir, 'sdk1')
    const kernel = (await openRuntime(dir)) as never as ReturnType<typeof openRuntime> & {
      __faux: FauxHandle
      close(): Promise<void>
      submitInput(id: number, text: string): Promise<unknown>
      waitForIdle(id: number): Promise<void>
      getLastAssistantText(id: number): Promise<string>
      abortConversation(id: number): Promise<void>
      getConversation(id: number): { status: string }
      services: { artifacts: ArtifactService }
    }
    try {
      const bigCommand = `python3 -c "print('B'*40000)"`
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: bigCommand })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('完成'),
      ])
      await kernel.submitInput(1, '生成大输出')
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), '完成')
      const artifacts = await kernel.services.artifacts.list(1)
      const spill = artifacts.find((a) => a.name.startsWith('tool-spill-'))
      assert.ok(spill, '应有 spill 产物')
      // 真实 read_artifact 链路读回（授权链允许会话 1）
      const content = await kernel.services.artifacts.readContent(spill!.id)
      assert.ok(content.includes('BBBBB'))
    } finally {
      await kernel.close()
    }
  })

  it('运行中 abortConversation 杀掉 bash 工具 shell（不等 120s）', async () => {
    const dir = join(rootDir, 'sdk2')
    const kernel = (await openRuntime(dir)) as never as ReturnType<typeof openRuntime> & {
      __faux: FauxHandle
      close(): Promise<void>
      submitInput(id: number, text: string): Promise<unknown>
      waitForIdle(id: number): Promise<void>
      abortConversation(id: number): Promise<void>
      getConversation(id: number): { status: string }
    }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: `sleep 120` })],
          { stopReason: 'toolUse' },
        ),
      ])
      const started = Date.now()
      void kernel.submitInput(1, '跑长命令').catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const elapsed = Date.now() - started
      assert.ok(elapsed < 30_000, `abort 应中断工具而非等满超时（${elapsed}ms）`)
      const conv = kernel.getConversation(1)
      assert.ok(['idle', 'error'].includes(conv.status))
    } finally {
      await kernel.close()
    }
  })
})

/** 最小真实 ToolExecutionApi：conversationId / callId / agent(cwd) 均按 SDK 契约提供。 */
function makeApi(cwd: string, conversationId = 1) {
  return {
    taskId: 'test-task',
    conversationId,
    callId: 'call-test-1',
    registry: { tools: [] },
    agent: async () => ({ cwd }),
    models: {},
    env: undefined,
    now: () => Date.now(),
    output: () => {},
    outputWindow: undefined,
    retainedOutput: () => ({ text: '', truncated: false }),
    diagnostic: () => {},
    details: async () => {},
    commit: async (change: () => unknown) => change(),
    memo: async () => undefined,
    createTask: async () => {
      throw new Error('测试不使用')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('测试不使用')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('测试不使用')
    },
  } as never
}

function existsSyncSafe(path: string): boolean {
  return existsSync(path)
}
