#!/usr/bin/env node
/**
 * herdr-smoke.mjs — `builtin:herdr` 真链路手工验收脚本（独立运行，不纳入 pnpm test）。
 *
 * 验收对象（全部真实组件，零 mock）：
 * - 编译产物 @helm/kernel：packages/kernel/dist/app.js 的 createHelm + WorkflowService；
 * - builtin:herdr 插件：setConfig -> enable -> agent_spawn 钩子接管外部运行时；
 * - 本机已安装 Herdr 服务：脚本自建隔离 headless session（独立 XDG_CONFIG_HOME、
 *   显式 socket path、子进程剔除继承的 HERDR_* 定位变量），绝不触碰用户现有
 *   session / pane / 主 Herdr 进程；
 * - 真实 pi CLI + GLM 模型（默认 provider=magpie / model=zhipu/glm-5.3，经
 *   `pi --list-models` 预检确认；可用 --provider/--model 覆盖）。
 *
 * 验收内容：
 * 1. 全新临时 Git 仓库 + seed 提交（git 身份用 -c 局部传参，不写宿主全局配置）；
 * 2. 工作流 run：agent #1（agentType=Profile 'herdr-smoke-pi'，isolation='worktree'，
 *    schema={answer:number}，gate=真实验证 artifact 并向 tempRoot 下 gate-count
 *    文件追加一行——Gate 执行次数的 shell 侧铁证）+ agent #2（resume:'task'
 *    在同一 Herdr pane 续聊并返回确认句）；
 * 3. 原始 run 断言：结构化结果字段、两节点 executionId 一致、Gate 仅第一节点
 *    且 ok=true 且 gate-count 恰好一行、worktree 目录/分支在 run 结算后仍保留、
 *    artifact.txt 内容真实、session.snapshot 确认本 workflow 的 pane 已全部关闭；
 * 4. resumeFromRunId 严格重放断言（引擎修复目标契约）：result 与原始 run 深相等、
 *    两个 agent 节点均 done 且 cached=true、经透明包装生产 transport 计数的
 *    agent.start / agent.prompt RPC 调用零增长、gate-count 仍恰好一行、
 *    snapshot 无新 pane/workspace。缓存节点不携带原 executionId/worktree 元数据
 *    （原 run 已验证过），重放只验证无新调用/无新资源。
 *
 * 传输层：导入与 app.js 同目录的 builtin-plugins/herdr/transport.js 的
 * createHerdrTransport（生产实现），透明包装 call 做方法计数后注入
 * createHelm({ herdrTransport })；绝不 mock 返回。脚本自身的 session.snapshot
 * 也复用该 transport（每次调用带有限 timeoutMs）。
 *
 * 依赖：node>=24、已执行 pnpm build（存在 packages/kernel/dist）、herdr / pi / git
 * 在 PATH、~/.pi/agent/auth.json 具备目标模型真实凭据。不监听任何端口。
 * 总超时：--timeout-ms（默认 180000，范围 60000..1800000）；清理阶段另有独立
 * 有界预算，超时后仍确保关闭自己创建的 herdr server。
 *
 * 输出：进度与 PASS/FAIL 逐项写 stderr；--json 时 stdout 恰好一个最终 JSON
 * 对象（可机器解析），非 --json 时 stdout 无输出。
 *
 * 用法：node scripts/herdr-smoke.mjs [--provider magpie] [--model zhipu/glm-5.3]
 *        [--timeout-ms 180000] [--keep-tmp] [--json]
 */

import { spawn, spawnSync } from 'node:child_process'
import { deepStrictEqual } from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const KERNEL_APP_PATH = process.env.HERDR_SMOKE_KERNEL_APP
  ? resolve(process.env.HERDR_SMOKE_KERNEL_APP)
  : resolve(SCRIPT_DIR, '..', 'packages', 'kernel', 'dist', 'app.js')
const PROFILE_ID = 'herdr-smoke-pi'
const ROOT_CONVERSATION_ID = 1
const ARTIFACT_NAME = 'artifact.txt'
const ARTIFACT_TEXT = 'hello\nfrom\nherdr-smoke\n'

class SmokeError extends Error {}

// ---------------------------------------------------------------------------
// CLI 参数
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = {
    provider: 'magpie',
    model: 'zhipu/glm-5.3',
    timeoutMs: 180_000,
    keepTmp: false,
    json: false,
    help: false,
  }
  const value = (i, flag) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new SmokeError(`参数 ${flag} 缺少取值`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--provider') out.provider = value(i++, a)
    else if (a === '--model') out.model = value(i++, a)
    else if (a === '--timeout-ms') {
      const raw = value(i++, a)
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 60_000 || n > 1_800_000) {
        throw new SmokeError(`--timeout-ms 必须是 60000..1800000 的整数（收到 ${raw}）`)
      }
      out.timeoutMs = n
    } else if (a === '--keep-tmp') out.keepTmp = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new SmokeError(`未知参数: ${a}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// 小工具：命令执行 / 日志 / 断言（全部输出走 stderr，stdout 只留给最终 JSON）
// ---------------------------------------------------------------------------

function tail(text, lines = 40) {
  if (!text) return ''
  const arr = String(text).split('\n')
  return arr.slice(Math.max(0, arr.length - lines)).join('\n')
}

function readFileOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 单引号安全引用（路径进入 shell 命令前统一走这里）。 */
function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`
}

/** spawnSync 包装：失败显式抛错并附输出尾部（不打印环境变量，杜绝机密泄漏）。
 *  同步子进程一律带硬超时，杜绝无限挂起破坏总超时纪律。 */
function runCmd(cmd, argv, options = {}) {
  const r = spawnSync(cmd, argv, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  })
  if (r.error) {
    const why = r.error.code === 'ETIMEDOUT' ? `（超时 ${options.timeoutMs ?? 30_000}ms 被终止）` : ''
    throw new SmokeError(`无法执行 ${cmd}${why}: ${r.error.message}`)
  }
  if (r.status !== 0) {
    throw new SmokeError(
      `${cmd} ${argv.join(' ')} 退出码 ${r.status}\n--stdout 尾部--\n${tail(r.stdout)}\n--stderr 尾部--\n${tail(r.stderr)}`,
    )
  }
  return r
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 有界预算：超时 reject（不吞），调用方 catch 计入清理问题。 */
function withBudget(promise, ms, label) {
  let timer
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)
  })
  return Promise.race([promise, timeoutP]).finally(() => clearTimeout(timer))
}

function hasExited(proc) {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForExit(proc, ms) {
  return new Promise((res) => {
    if (hasExited(proc)) return res()
    const onExit = () => {
      clearTimeout(timer)
      res()
    }
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      res()
    }, ms)
    proc.once('exit', onExit)
  })
}

const results = []

function log(message) {
  process.stderr.write(`${String(message)}\n`)
}

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  if (!ok) throw new SmokeError(`验收项失败: ${name}${detail !== undefined ? `（${detail}）` : ''}`)
}

// ---------------------------------------------------------------------------
// Herdr 隔离 headless session
// ---------------------------------------------------------------------------

/** 剔除继承的 HERDR_* 定位变量（防止子进程误连调用者的 pane/socket），再注入隔离配置。 */
function buildHerdrEnv(baseEnv, xdgHome, socketPath) {
  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_')) delete env[key]
  }
  env.XDG_CONFIG_HOME = xdgHome
  env.HERDR_SOCKET_PATH = socketPath
  return env
}

/** 透明包装生产 transport：仅按 method 计数，行为完全透传（绝不 mock 返回）。 */
function createTracedTransport(base) {
  const counts = { 'agent.start': 0, 'agent.prompt': 0 }
  const traced = {
    call(target, method, params, options) {
      if (method in counts) counts[method] += 1
      return base.call(target, method, params, options)
    },
    readOutput: (t, c, f, s) => base.readOutput(t, c, f, s),
    removeOutput: (t, c, f, s) => base.removeOutput(t, c, f, s),
    runGate: (t, cmd, c, s, e) => base.runGate(t, cmd, c, s, e),
    subscribe: (t, onEvent, onError) => base.subscribe(t, onEvent, onError),
  }
  return { transport: traced, counts }
}

/** session.snapshot -> {type:'session_snapshot', snapshot:{agents,panes,tabs,workspaces}}（protocol 22）。 */
async function snapshotSession(transport, socketPath, timeoutMs = 5_000) {
  const result = await transport.call({ socketPath }, 'session.snapshot', {}, { timeoutMs })
  const snap = result && typeof result === 'object' ? result.snapshot : undefined
  if (
    !snap ||
    !Array.isArray(snap.agents) ||
    !Array.isArray(snap.panes) ||
    !Array.isArray(snap.workspaces) ||
    !Array.isArray(snap.tabs)
  ) {
    throw new SmokeError(`session.snapshot 形状异常: ${JSON.stringify(result).slice(0, 300)}`)
  }
  return snap
}

// ---------------------------------------------------------------------------
// 工作流脚本构造
// ---------------------------------------------------------------------------

function buildWorkflowScript(profileId, gateCommand) {
  const taskPrompt = [
    '你正在一个 Git worktree 中工作。请完成两件事：',
    `1. 在当前工作目录创建 ${ARTIFACT_NAME}：内容恰好三行文本 hello、from、herdr-smoke，每行以单个换行符结束（文件共 3 行，不要添加其他任何内容）。`,
    `2. answer 字段填写 ${ARTIFACT_NAME} 的实际行数（数字），按系统指令末尾给出的 JSON 交接文件要求提交结构化结果。`,
  ].join('\n')
  const resumePrompt =
    '在同一上下文继续：用一句简短的 Markdown 确认你刚刚在当前工作目录创建了 artifact.txt。不要做其他任何事。'
  return [
    'export const meta = { name: "herdr-smoke", description: "builtin:herdr 真链路验收" }',
    `const first = await agent(${JSON.stringify(taskPrompt)}, { label: "task", agentType: ${JSON.stringify(profileId)}, isolation: "worktree", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false }, gate: ${JSON.stringify(gateCommand)} })`,
    'if (first === null || first === undefined) throw new Error("第一个节点返回 null：应经 JSON 交接文件返回 {answer:number}")',
    'if (typeof first !== "object" || typeof first.answer !== "number") throw new Error("第一个节点结构非法: " + JSON.stringify(first))',
    `const second = await agent(${JSON.stringify(resumePrompt)}, { resume: "task" })`,
    'if (second === null || second === undefined) throw new Error("resume 节点返回 null")',
    'if (typeof second !== "string" || second.trim() === "") throw new Error("resume 节点应返回非空确认文本: " + JSON.stringify(second))',
    'return { first: first, second: second }',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgv(process.argv.slice(2))
  if (args.help) {
    log('用法: node scripts/herdr-smoke.mjs [--provider magpie] [--model zhipu/glm-5.3] [--timeout-ms 180000] [--keep-tmp] [--json]')
    return
  }

  const deadlineAt = Date.now() + args.timeoutMs
  const withDeadline = (promise, label) => withBudget(promise, deadlineAt - Date.now(), `总超时(${args.timeoutMs}ms)·${label}`)
  const assertTimeLeft = (label) => {
    if (Date.now() >= deadlineAt) throw new SmokeError(`总超时(${args.timeoutMs}ms)耗尽，阶段: ${label}`)
  }

  const state = {
    tmpRoot: '',
    repoDir: '',
    xdgHome: '',
    dataDir: '',
    gateCountPath: '',
    herdr: undefined,
    app: undefined,
    workflows: undefined,
    activeRunIds: new Set(),
    worktreePaths: [],
    success: false,
  }

  let runError = null
  try {
    // ---- 0) 预检：本地依赖与真实模型目录（只读，不触任何 Herdr 控制命令） ----
    const nodeMajor = Number(process.versions.node.split('.')[0])
    check('node 主版本 >= 24', nodeMajor >= 24, process.versions.node)
    check('内核编译产物存在（先 pnpm build）', existsSync(KERNEL_APP_PATH), KERNEL_APP_PATH)
    const transportModulePath = join(dirname(KERNEL_APP_PATH), 'builtin-plugins', 'herdr', 'transport.js')
    check('herdr 传输层编译产物存在', existsSync(transportModulePath), transportModulePath)
    runCmd('herdr', ['--version'])
    runCmd('git', ['--version'])
    const listModels = runCmd('pi', ['--list-models', args.model])
    const modelHit = listModels.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => {
        const cols = l.split(/\s+/)
        return cols[0] === args.provider && cols[1] === args.model
      })
    check('pi 模型目录含目标模型（真实凭据前置条件）', modelHit !== undefined, `${args.provider}/${args.model}`)

    // ---- 1) 临时环境布局 ----
    state.tmpRoot = mkdtempSync(join(tmpdir(), 'helm-herdr-smoke-'))
    state.repoDir = join(state.tmpRoot, 'repo')
    state.xdgHome = join(state.tmpRoot, 'xdg')
    state.dataDir = join(state.tmpRoot, 'helm-data')
    state.gateCountPath = join(state.tmpRoot, 'gate-count')
    const logsDir = join(state.tmpRoot, 'logs')
    mkdirSync(state.repoDir, { recursive: true })
    mkdirSync(state.xdgHome, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    log(`临时根: ${state.tmpRoot}`)

    // ---- 2) 全新 Git 仓库 + seed 提交（不写宿主全局 git 配置） ----
    runCmd('git', ['-C', state.repoDir, 'init', '-b', 'main'])
    writeFileSync(join(state.repoDir, 'README.md'), '# helm herdr smoke seed\n')
    const gitIdentity = ['-c', 'user.name=helm-smoke', '-c', 'user.email=helm-smoke@example.com', '-c', 'commit.gpgsign=false']
    runCmd('git', ['-C', state.repoDir, 'add', 'README.md'])
    runCmd('git', ['-C', state.repoDir, ...gitIdentity, 'commit', '-m', 'seed', '--quiet'])
    const seedHead = runCmd('git', ['-C', state.repoDir, 'rev-parse', 'HEAD']).stdout.trim()
    check('临时 Git 仓库 seed 提交完成', seedHead.length > 0, seedHead.slice(0, 12))

    // ---- 3) 隔离 headless Herdr session（前台 server 子进程 + 完整日志） ----
    const sessionName = `helm-smoke-${process.pid}-${Date.now().toString(36)}`
    const socketPath = join(state.xdgHome, 'herdr', 'sessions', sessionName, 'herdr.sock')
    const herdrEnv = buildHerdrEnv(process.env, state.xdgHome, socketPath)
    const serverLogPath = join(logsDir, 'herdr-server.log')
    const serverLogFd = openSync(serverLogPath, 'a')
    const serverProc = spawn('herdr', ['--session', sessionName, 'server'], {
      cwd: state.tmpRoot,
      env: herdrEnv,
      stdio: ['ignore', serverLogFd, serverLogFd],
    })
    closeSync(serverLogFd)
    const spawnErrorHolder = { err: undefined }
    serverProc.once('error', (err) => {
      spawnErrorHolder.err = err
    })
    state.herdr = { session: sessionName, socketPath, env: herdrEnv, proc: serverProc, logPath: serverLogPath }
    log(`herdr headless session: ${sessionName}（socket: ${socketPath}）`)
    log(`herdr server 日志: ${serverLogPath}`)

    // 环境净化（须先于内核/传输层加载与任何其调用）：socket 解析优先级为
    // socketPath > HERDR_SOCKET_PATH > session（session 经 XDG_CONFIG_HOME 推导）。
    // 本脚本将三者全部指向同一隔离 socket，任何优先级下解析一致；同时剔除继承
    // 的 HERDR_* 定位变量，防止内核/插件误连调用者所在的主 Herdr。
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('HERDR_')) delete process.env[key]
    }
    process.env.XDG_CONFIG_HOME = state.xdgHome
    process.env.HERDR_SOCKET_PATH = socketPath

    // ---- 4) 生产 transport（脚本自查 + 注入内核的基座） ----
    const { createHerdrTransport } = await import(transportModulePath)
    const baseTransport = createHerdrTransport()

    let initialSnap
    for (;;) {
      assertTimeLeft('等待 herdr socket 就绪')
      if (spawnErrorHolder.err) {
        throw new SmokeError(`herdr server 启动失败: ${spawnErrorHolder.err.message}`)
      }
      if (hasExited(serverProc)) {
        throw new SmokeError(
          `herdr server 提前退出（code=${serverProc.exitCode} signal=${serverProc.signalCode}），日志尾部:\n${tail(readFileOrEmpty(serverLogPath))}`,
        )
      }
      if (existsSync(socketPath)) {
        try {
          initialSnap = await snapshotSession(baseTransport, socketPath, 3_000)
          break
        } catch {
          /* socket 尚未就绪，继续轮询（250ms 连接退避，不用 sleep 猜流程完成） */
        }
      }
      await sleep(250)
    }
    check('隔离 session 初始 panes 为空', initialSnap.panes.length === 0, `panes=${initialSnap.panes.length}`)
    check('隔离 session 初始 agents 为空', initialSnap.agents.length === 0, `agents=${initialSnap.agents.length}`)
    const initialWorkspaceIds = new Set(initialSnap.workspaces.map((w) => w.workspace_id))
    if (initialWorkspaceIds.size > 0) {
      log(`NOTE 隔离 session 初始即存在 ${initialWorkspaceIds.size} 个 workspace（headless 启动事实，后续断言不残留新增）`)
    }

    // ---- 5) createHelm（真实编译产物 + 注入计数 transport）+ 插件启用 + Profile ----
    // createHelm 的 cwd 成为根会话 cwd 与 herdr 默认 cwd：指向临时 repo，
    // isolation:'worktree' 的 herdr worktree create --cwd 将在其内建树。
    const { createHelm } = await import(KERNEL_APP_PATH)
    const traced = createTracedTransport(baseTransport)
    const app = await withDeadline(
      createHelm({ dataDir: state.dataDir, cwd: state.repoDir, herdrTransport: traced.transport }),
      'createHelm 启动',
    )
    state.app = app
    state.workflows = app.workflows
    await app.kernel.plugins.setConfig('builtin:herdr', {
      session: sessionName,
      socketPath,
      startupTimeoutMs: 30_000,
    })
    await withDeadline(app.kernel.plugins.enable('builtin:herdr'), '启用 builtin:herdr')
    await app.kernel.profiles.save({
      id: PROFILE_ID,
      name: 'Herdr smoke pi',
      runtime: {
        kind: 'herdr',
        agent: 'pi',
        args: [
          '--provider', args.provider,
          '--model', args.model,
          '--thinking', 'off',
          '-a',
          '--no-session',
        ],
      },
    })
    const savedProfile = await app.kernel.profiles.get(PROFILE_ID)
    check(
      'Profile 已保存且绑定 herdr 运行时',
      savedProfile?.runtime?.kind === 'herdr' && savedProfile.runtime.agent === 'pi',
      JSON.stringify(savedProfile?.runtime),
    )

    // Gate 命令：真实验证 artifact 后向 tempRoot 下 gate-count 追加一行——
    // Gate 执行次数的 shell 侧铁证（不依赖 node.gate 元数据，它能证明没执行两次）。
    const gateCommand =
      `test "$(wc -l < ${ARTIFACT_NAME})" -eq 3 && printf 'x\\n' >> ${shellQuote(state.gateCountPath)}`
    const gateCountLines = () => {
      const content = readFileOrEmpty(state.gateCountPath)
      return content.split('\n').filter((l) => l !== '').length
    }
    const script = buildWorkflowScript(PROFILE_ID, gateCommand)

    // ---- 6) 原始 run：agent(worktree+schema+gate) + resume 续聊 ----
    const run1 = await state.workflows.run({ script, conversationId: ROOT_CONVERSATION_ID })
    state.activeRunIds.add(run1.id)
    log(`原始 run: ${run1.id}`)
    const result1 = await withDeadline(state.workflows.wait(run1.id), '原始 run 执行（真实 GLM 模型调用）')
    state.activeRunIds.delete(run1.id)
    const summary1 = state.workflows.getRun(run1.id)

    check('原始 run 状态 completed', summary1.status === 'completed', summary1.error ?? summary1.status)
    check('原始 run 挂在根会话 #1', summary1.conversationId === ROOT_CONVERSATION_ID, String(summary1.conversationId))
    const r1 = result1 && typeof result1 === 'object' ? result1 : undefined
    check(
      '原始 run 结果 first.answer === 3（JSON 交接文件字段）',
      r1?.first && typeof r1.first.answer === 'number' && r1.first.answer === 3,
      JSON.stringify(r1?.first),
    )
    check(
      '原始 run 结果 second 为非空确认文本',
      typeof r1?.second === 'string' && r1.second.trim() !== '',
      JSON.stringify(String(r1?.second ?? '').slice(0, 80)),
    )

    const nodes1 = summary1.nodes ?? []
    check(
      '原始 run 恰好 2 个 agent 节点且全部 done',
      nodes1.length === 2 && nodes1.every((n) => n.kind === 'agent' && n.status === 'done'),
      JSON.stringify(nodes1.map((n) => `${n.id}:${n.status}`)),
    )
    const [nodeA1, nodeB1] = nodes1
    check(
      '原始 run 两节点 executionId 相同（同一 Herdr pane 续聊）',
      typeof nodeA1?.executionId === 'string' &&
        nodeA1.executionId !== '' &&
        nodeA1.executionId === nodeB1?.executionId,
      `agent-0=${nodeA1?.executionId} agent-1=${nodeB1?.executionId}`,
    )
    check(
      'Gate 仅第一节点且 ok=true，gate-count 恰好一行（shell 侧恰好执行一次）',
      nodeA1?.gate?.ok === true && nodeB1?.gate === undefined && gateCountLines() === 1,
      JSON.stringify({ nodeGate: nodeA1?.gate, secondNodeGate: nodeB1?.gate, gateCount: gateCountLines() }),
    )
    const wt1 = nodeA1?.worktree
    check('第一节点带 worktree 元数据', wt1 && isAbsolute(wt1.path) && typeof wt1.branch === 'string' && wt1.branch !== '', JSON.stringify(wt1))
    check('worktree 目录在 run 结算后仍保留', existsSync(wt1.path), wt1.path)
    const branchList1 = runCmd('git', ['-C', state.repoDir, 'branch', '--list', wt1.branch]).stdout.trim()
    check('worktree 分支在 run 结算后仍保留', branchList1.includes(wt1.branch), branchList1 || `（未找到 ${wt1.branch}）`)
    const artifact1 = existsSync(join(wt1.path, ARTIFACT_NAME))
      ? readFileSync(join(wt1.path, ARTIFACT_NAME), 'utf8')
      : undefined
    check(`worktree 内 ${ARTIFACT_NAME} 内容真实（三行）`, artifact1 === ARTIFACT_TEXT, JSON.stringify(artifact1))
    state.worktreePaths.push(wt1.path)

    // 真实 Herdr snapshot：本 workflow 的 pane 已全部关闭（wait 返回时 onRunSettled 已完成）
    const snap1 = await withDeadline(snapshotSession(baseTransport, socketPath), '原始 run 后 snapshot')
    const paneStillThere =
      snap1.panes.some((p) => p.pane_id === nodeA1.executionId) ||
      snap1.agents.some((a) => a.pane_id === nodeA1.executionId)
    const residue1 = snap1.workspaces.filter((w) => !initialWorkspaceIds.has(w.workspace_id))
    check(
      '原始 run 结算后 Herdr snapshot 无残留 pane/workspace',
      !paneStillThere && snap1.panes.length === 0 && snap1.agents.length === 0 && residue1.length === 0,
      `panes=${snap1.panes.length} agents=${snap1.agents.length} 新增workspace=${residue1.length}`,
    )

    // ---- 7) resumeFromRunId 严格重放（引擎修复目标契约：缓存前缀，零新副作用） ----
    const countsAfterRun1 = { ...traced.counts }
    log(`原始 run 后 RPC 计数: agent.start=${countsAfterRun1['agent.start']} agent.prompt=${countsAfterRun1['agent.prompt']}（不硬编码具体值，允许一次合法自愈）`)

    const run2 = await state.workflows.run({ resumeFromRunId: run1.id, conversationId: ROOT_CONVERSATION_ID })
    state.activeRunIds.add(run2.id)
    log(`重放 run: ${run2.id}（replayedFrom=${run1.id}）`)
    const result2 = await withDeadline(state.workflows.wait(run2.id), '重放 run 执行')
    state.activeRunIds.delete(run2.id)
    const summary2 = state.workflows.getRun(run2.id)

    check('重放 run 状态 completed', summary2.status === 'completed', summary2.error ?? summary2.status)
    check('重放 run 携带 replayedFrom 标记', summary2.replayedFrom === run1.id, String(summary2.replayedFrom))

    let deepOk = true
    let deepWhy = ''
    try {
      deepStrictEqual(result2, result1)
    } catch (e) {
      deepOk = false
      deepWhy = e instanceof Error ? e.message.slice(0, 200) : String(e)
    }
    check('重放结果与原始 run 深相等（缓存前缀重放）', deepOk, deepWhy)

    const nodes2 = summary2.nodes ?? []
    check(
      '重放 run 恰好 2 个 agent 节点、全部 done 且 cached=true（缓存命中而非 live 重跑）',
      nodes2.length === 2 && nodes2.every((n) => n.kind === 'agent' && n.status === 'done' && n.cached === true),
      JSON.stringify(nodes2.map((n) => `${n.id}:${n.status}:cached=${String(n.cached)}`)),
    )

    check(
      '重放零新增 Herdr 调用（agent.start / agent.prompt 计数不变）',
      traced.counts['agent.start'] === countsAfterRun1['agent.start'] &&
        traced.counts['agent.prompt'] === countsAfterRun1['agent.prompt'],
      `agent.start ${countsAfterRun1['agent.start']}->${traced.counts['agent.start']}，agent.prompt ${countsAfterRun1['agent.prompt']}->${traced.counts['agent.prompt']}`,
    )
    check('重放不重跑 Gate（gate-count 仍恰好一行）', gateCountLines() === 1, `gateCount=${gateCountLines()}`)

    const snap2 = await withDeadline(snapshotSession(baseTransport, socketPath), '重放 run 后 snapshot')
    const residue2 = snap2.workspaces.filter((w) => !initialWorkspaceIds.has(w.workspace_id))
    check(
      '重放 run 结算后隔离 session 无新 pane/workspace（零新资源）',
      snap2.panes.length === 0 && snap2.agents.length === 0 && residue2.length === 0,
      `panes=${snap2.panes.length} agents=${snap2.agents.length} 新增workspace=${residue2.length}`,
    )

    state.success = true
  } catch (err) {
    runError = err
  }

  // ---- 清理（有界预算；任一失败 => 整体 FAIL 且保留现场） ----
  const problems = await cleanup(state, args)
  const ok = runError === null && state.success && problems.length === 0
  const failed = results.filter((r) => !r.ok).length

  if (runError !== null) {
    log(`HERDR-SMOKE: FAIL — ${runError instanceof Error ? runError.message : String(runError)}`)
  }
  for (const p of problems) log(`CLEANUP-FAIL ${p}`)
  log(`== helm herdr-smoke 汇总 == PASS ${results.length - failed} / FAIL ${failed}${problems.length > 0 ? ` / 清理失败 ${problems.length}` : ''}`)
  log(`HERDR-SMOKE: ${ok ? 'PASS' : 'FAIL'}`)
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok, passed: results.length - failed, failed, cleanupFailures: problems, results })}\n`)
  }
  if (!ok) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// 清理：只动自己创建的资源；任一失败计为整体 FAIL 并保留现场与日志
// ---------------------------------------------------------------------------

async function cleanup(state, args) {
  const problems = []
  const step = (label, ms, fn) =>
    withBudget(fn(), ms, label).catch((e) => {
      problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    })

  // 1) 在途 run 尽力中止（总超时/失败路径下不能留着假 running）
  if (state.workflows && state.activeRunIds.size > 0) {
    for (const runId of [...state.activeRunIds]) {
      await step(`abort run ${runId}`, 5_000, () => state.workflows.abort(runId))
    }
  }

  // 2) 关闭内核（插件 teardown；已终态 run 不会被阻塞）
  if (state.app) {
    await step('app.close', 10_000, () => state.app.close())
  }

  // 3) 只停自己创建的 headless session（同一隔离 env 经显式 socket 寻址，绝不触碰主 Herdr）
  if (state.herdr && !hasExited(state.herdr.proc)) {
    try {
      runCmd('herdr', ['--session', state.herdr.session, 'server', 'stop'], {
        env: state.herdr.env,
        timeoutMs: 15_000,
      })
    } catch (e) {
      problems.push(`herdr server stop: ${tail(e instanceof Error ? e.message : String(e), 5)}`)
    }
    await waitForExit(state.herdr.proc, 10_000)
    if (!hasExited(state.herdr.proc)) {
      state.herdr.proc.kill('SIGTERM')
      await waitForExit(state.herdr.proc, 5_000)
      if (!hasExited(state.herdr.proc)) {
        state.herdr.proc.kill('SIGKILL')
        await waitForExit(state.herdr.proc, 5_000)
      }
    }
    if (!hasExited(state.herdr.proc)) {
      problems.push(`herdr server pid=${state.herdr.proc.pid} 最终未能终止`)
    }
  }

  if (state.success && problems.length === 0) {
    // 4) 成功路径：先验证 worktree 目录/分支确实保留（验收断言已过），再清理
    //    自己创建的 worktree；仅当 git common-dir 属于本次临时仓库才允许移除。
    for (const wtPath of [...new Set(state.worktreePaths)]) {
      if (!existsSync(wtPath)) continue
      try {
        const raw = runCmd('git', ['-C', wtPath, 'rev-parse', '--git-common-dir'], { timeoutMs: 10_000 }).stdout.trim()
        const commonDir = isAbsolute(raw) ? raw : resolve(wtPath, raw)
        const expected = resolve(state.repoDir, '.git')
        if (commonDir !== expected) {
          throw new SmokeError(`拒绝移除非本次临时仓库的 worktree: ${wtPath}（common-dir=${commonDir}，期望 ${expected}）`)
        }
        runCmd('git', ['-C', state.repoDir, 'worktree', 'remove', '--force', wtPath], { timeoutMs: 15_000 })
        log(`已清理 worktree: ${wtPath}`)
      } catch (e) {
        problems.push(`worktree 清理 ${wtPath}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!args.keepTmp) {
      try {
        rmSync(state.tmpRoot, { recursive: true, force: true })
        log(`已清理临时根: ${state.tmpRoot}`)
      } catch (e) {
        problems.push(`临时根清理: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      log(`--keep-tmp：保留临时根 ${state.tmpRoot}（herdr 日志: ${state.herdr?.logPath}）`)
    }
  } else if (state.tmpRoot !== '') {
    // 任一失败：绝不删日志与现场，输出诊断入口
    log(`失败现场已保留: ${state.tmpRoot}`)
    if (state.herdr) log(`herdr server 日志: ${state.herdr.logPath}`)
  }

  return problems
}

main().catch((err) => {
  process.stderr.write(`HERDR-SMOKE: FAIL — ${err instanceof Error ? err.message : String(err)}\n`)
  if (err instanceof Error && err.stack) process.stderr.write(`${tail(err.stack, 12)}\n`)
  process.exit(1)
})
