#!/usr/bin/env node
/**
 * herdr-smoke.mjs — manual real-chain acceptance script for `builtin:herdr` (standalone, not part of pnpm test).
 *
 * Acceptance targets (all real components, zero mocks):
 * - The @helm/hub build artifact: createHelm from packages/hub/dist/app.js;
 * - The builtin:herdr plugin: setConfig -> enable -> the agent_spawn hook takes over the
 *   external runtime;
 * - A locally installed Herdr service: the script creates its own isolated headless session
 *   (dedicated XDG_CONFIG_HOME, explicit socket path, child processes stripped of inherited
 *   HERDR_* locator variables) and never touches the user's existing session / panes / the
 *   main Herdr process;
 * - The real pi CLI + GLM model (default provider=magpie / model=zhipu/glm-5.3, confirmed by
 *   the `pi --list-models` preflight; override with --provider/--model).
 *
 * What is verified:
 * 1. A fresh temporary Git repo + seed commit (git identity passed locally via -c; the host
 *    global config is never written);
 * 2. A workflow run: agent #1 (agentType=Profile 'herdr-smoke-pi', isolation='worktree',
 *    schema={answer:number}, gate=real artifact validation appending one line to a
 *    gate-count file under tempRoot — hard shell-side evidence of the Gate execution count)
 *    + agent #2 (resume:'task' continues in the same Herdr pane and returns a confirmation
 *    sentence);
 * 3. Original run assertions: structured result fields, identical executionId across the two
 *    nodes, Gate only on the first node with ok=true and gate-count at exactly one line,
 *    worktree dir/branch still present after the run settles, real artifact.txt content, and
 *    session.snapshot confirming every pane of this workflow is closed;
 * 4. Strict resumeFromRunId replay assertions (the engine-fix target contract): the result
 *    deep-equals the original run, both agent nodes are done with cached=true, zero growth of
 *    agent.start / agent.prompt RPC calls counted through the transparently wrapped
 *    production transport, gate-count still at exactly one line, and the snapshot exactly
 *    restores the pre-existing pane/tab/workspace baseline (existing panes preserved).
 *    Cached nodes carry no original executionId/worktree metadata (the original run already
 *    verified those); the replay only verifies no new calls / no new resources.
 *
 * Transport layer: imports createHerdrTransport (the production implementation) from the
 * @helm/plugins build artifact (packages/plugins/dist/herdr/transport.js), transparently
 * wraps call for method counting, and injects it into createHelm({ herdrTransport }); never
 * mocks returns. The script's own session.snapshot also reuses that transport (each call
 * carries a bounded timeoutMs).
 *
 * Requirements: node>=24, pnpm build already run (packages/hub/dist and
 * packages/plugins/dist exist), herdr / pi / git on PATH, real credentials for the target
 * model in ~/.pi/agent/auth.json. No port is ever listened on.
 * Total timeout: --timeout-ms (default 180000, range 60000..1800000); the cleanup phase has
 * its own bounded budget, and even after a timeout the herdr server created here is still
 * guaranteed to be closed.
 *
 * Output: progress and PASS/FAIL per item go to stderr; with --json, stdout carries exactly
 * one final JSON object (machine-parseable); without --json, stdout stays empty.
 *
 * Usage: node scripts/herdr-smoke.mjs [--provider magpie] [--model zhipu/glm-5.3]
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
  : resolve(SCRIPT_DIR, '..', 'packages', 'hub', 'dist', 'app.js')
const PROFILE_ID = 'herdr-smoke-pi'
const ROOT_CONVERSATION_ID = 1
const ARTIFACT_NAME = 'artifact.txt'
const ARTIFACT_TEXT = 'hello\nfrom\nherdr-smoke\n'

class SmokeError extends Error {}

// ---------------------------------------------------------------------------
// CLI arguments
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
    if (v === undefined || v.startsWith('--')) throw new SmokeError(`argument ${flag} is missing a value`)
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
        throw new SmokeError(`--timeout-ms must be an integer in 60000..1800000 (got ${raw})`)
      }
      out.timeoutMs = n
    } else if (a === '--keep-tmp') out.keepTmp = true
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new SmokeError(`unknown argument: ${a}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Utilities: command execution / logging / assertions (all output to stderr; stdout is
// reserved for the final JSON only)
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

/** Safe single-quoting (paths go through this before entering shell commands). */
function shellQuote(text) {
  return `'${String(text).replaceAll("'", `'\\''`)}'`
}

/** spawnSync wrapper: throws explicitly on failure with output tails attached (env vars are
 *  never printed, so secrets cannot leak). Every synchronous child process carries a hard
 *  timeout so nothing can hang forever and break the total-timeout discipline. */
function runCmd(cmd, argv, options = {}) {
  const r = spawnSync(cmd, argv, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30_000,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  })
  if (r.error) {
    const why = r.error.code === 'ETIMEDOUT' ? ` (killed after a ${options.timeoutMs ?? 30_000}ms timeout)` : ''
    throw new SmokeError(`cannot execute ${cmd}${why}: ${r.error.message}`)
  }
  if (r.status !== 0) {
    throw new SmokeError(
      `${cmd} ${argv.join(' ')} exit code ${r.status}\n--stdout tail--\n${tail(r.stdout)}\n--stderr tail--\n${tail(r.stderr)}`,
    )
  }
  return r
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Bounded budget: rejects on timeout (never swallows it); the caller catches and counts it as a cleanup problem. */
function withBudget(promise, ms, label) {
  let timer
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms)
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
  if (!ok) throw new SmokeError(`acceptance item failed: ${name}${detail !== undefined ? ` (${detail})` : ''}`)
}

// ---------------------------------------------------------------------------
// Isolated headless Herdr session
// ---------------------------------------------------------------------------

/** Strip inherited HERDR_* locator variables (so children never connect to the caller's pane/socket by accident), then inject the isolated config. */
function buildHerdrEnv(baseEnv, xdgHome, socketPath) {
  const env = { ...baseEnv }
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_')) delete env[key]
  }
  env.XDG_CONFIG_HOME = xdgHome
  env.HERDR_SOCKET_PATH = socketPath
  return env
}

/** Transparently wrap the production transport: count by method only, pass behavior straight through (never mock returns). */
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

/** session.snapshot -> {type:'session_snapshot', snapshot:{agents,panes,tabs,workspaces}} (protocol 22). */
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
    throw new SmokeError(`malformed session.snapshot shape: ${JSON.stringify(result).slice(0, 300)}`)
  }
  return snap
}

// ---------------------------------------------------------------------------
// Workflow script construction
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
// Main flow
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgv(process.argv.slice(2))
  if (args.help) {
    log('Usage: node scripts/herdr-smoke.mjs [--provider magpie] [--model zhipu/glm-5.3] [--timeout-ms 180000] [--keep-tmp] [--json]')
    return
  }

  const deadlineAt = Date.now() + args.timeoutMs
  const withDeadline = (promise, label) => withBudget(promise, deadlineAt - Date.now(), `deadline(${args.timeoutMs}ms)·${label}`)
  const assertTimeLeft = (label) => {
    if (Date.now() >= deadlineAt) throw new SmokeError(`total timeout (${args.timeoutMs}ms) exhausted at stage: ${label}`)
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
    // ---- 0) Preflight: local dependencies and the real model catalog (read-only; no Herdr control commands) ----
    const nodeMajor = Number(process.versions.node.split('.')[0])
    check('node major version >= 24', nodeMajor >= 24, process.versions.node)
    check('kernel build artifact exists (run pnpm build first)', existsSync(KERNEL_APP_PATH), KERNEL_APP_PATH)
    const transportModulePath = resolve(SCRIPT_DIR, '..', 'packages', 'plugins', 'dist', 'herdr', 'transport.js')
    check('herdr transport build artifact exists', existsSync(transportModulePath), transportModulePath)
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
    check('pi model catalog contains the target model (precondition for real credentials)', modelHit !== undefined, `${args.provider}/${args.model}`)

    // ---- 1) Temporary environment layout ----
    state.tmpRoot = mkdtempSync(join(tmpdir(), 'helm-herdr-smoke-'))
    state.repoDir = join(state.tmpRoot, 'repo')
    state.xdgHome = join(state.tmpRoot, 'xdg')
    state.dataDir = join(state.tmpRoot, 'helm-data')
    state.gateCountPath = join(state.tmpRoot, 'gate-count')
    const logsDir = join(state.tmpRoot, 'logs')
    mkdirSync(state.repoDir, { recursive: true })
    mkdirSync(state.xdgHome, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    log(`temp root: ${state.tmpRoot}`)

    // ---- 2) Fresh Git repo + seed commit (the host global git config is never written) ----
    runCmd('git', ['-C', state.repoDir, 'init', '-b', 'main'])
    writeFileSync(join(state.repoDir, 'README.md'), '# helm herdr smoke seed\n')
    const gitIdentity = ['-c', 'user.name=helm-smoke', '-c', 'user.email=helm-smoke@example.com', '-c', 'commit.gpgsign=false']
    runCmd('git', ['-C', state.repoDir, 'add', 'README.md'])
    runCmd('git', ['-C', state.repoDir, ...gitIdentity, 'commit', '-m', 'seed', '--quiet'])
    const seedHead = runCmd('git', ['-C', state.repoDir, 'rev-parse', 'HEAD']).stdout.trim()
    check('temporary Git repo seed commit done', seedHead.length > 0, seedHead.slice(0, 12))

    // ---- 3) Isolated headless Herdr session (foreground server child process + full logs) ----
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
    log(`herdr headless session: ${sessionName} (socket: ${socketPath})`)
    log(`herdr server log: ${serverLogPath}`)

    // Environment scrubbing (must happen before the kernel/transport load and any of their
    // calls): socket resolution priority is socketPath > HERDR_SOCKET_PATH > session (the
    // session is derived via XDG_CONFIG_HOME). This script points all three at the same
    // isolated socket so resolution is identical under any priority; inherited HERDR_*
    // locator variables are also stripped so the kernel/plugins never connect to the main
    // Herdr the caller sits in.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('HERDR_')) delete process.env[key]
    }
    process.env.XDG_CONFIG_HOME = state.xdgHome
    process.env.HERDR_SOCKET_PATH = socketPath

    // ---- 4) Production transport (the base for both self-checks and the kernel injection) ----
    const { createHerdrTransport } = await import(transportModulePath)
    const baseTransport = createHerdrTransport()

    let initialSnap
    for (;;) {
      assertTimeLeft('waiting for the herdr socket to become ready')
      if (spawnErrorHolder.err) {
        throw new SmokeError(`herdr server failed to start: ${spawnErrorHolder.err.message}`)
      }
      if (hasExited(serverProc)) {
        throw new SmokeError(
          `herdr server exited early (code=${serverProc.exitCode} signal=${serverProc.signalCode}), log tail:\n${tail(readFileOrEmpty(serverLogPath))}`,
        )
      }
      if (existsSync(socketPath)) {
        try {
          initialSnap = await snapshotSession(baseTransport, socketPath, 3_000)
          break
        } catch {
          /* socket not ready yet, keep polling (250ms connect backoff; no sleep-based guessing that startup finished) */
        }
      }
      await sleep(250)
    }
    check('isolated session starts with zero panes', initialSnap.panes.length === 0, `panes=${initialSnap.panes.length}`)
    check('isolated session starts with zero agents', initialSnap.agents.length === 0, `agents=${initialSnap.agents.length}`)
    // Herdr opens a plain workspace of the original repo automatically on the first
    // worktree.create. Establish the baseline explicitly so we can verify precisely that
    // pre-existing panes stay and all newly delegated resources are cleaned up.
    await withDeadline(baseTransport.call({ socketPath }, 'workspace.create', {
      cwd: state.repoDir,
      label: 'smoke-existing-workspace',
      focus: false,
    }, { timeoutMs: 5_000 }), 'establishing the pre-existing workspace baseline')
    const baselineSnap = await withDeadline(snapshotSession(baseTransport, socketPath), 'reading the pre-existing workspace baseline')
    const baselineIds = (snapshot) => ({
      workspaces: snapshot.workspaces.map((w) => w.workspace_id).sort(),
      tabs: snapshot.tabs.map((t) => t.tab_id).sort(),
      panes: snapshot.panes.map((p) => p.pane_id).sort(),
      agents: snapshot.agents.map((a) => a.pane_id).sort(),
    })
    const baseline = baselineIds(baselineSnap)
    check('pre-existing workspace baseline has a plain pane and no Agent', baseline.panes.length > 0 && baseline.agents.length === 0, JSON.stringify(baseline))
    const matchesBaseline = (snapshot) => {
      try { deepStrictEqual(baselineIds(snapshot), baseline); return true } catch { return false }
    }

    // ---- 5) createHelm (real build artifact + injected counting transport) + plugin enable + Profile ----
    // createHelm's cwd becomes the root conversation cwd and the herdr default cwd: it points
    // at the temp repo, where the herdr worktree create --cwd of isolation:'worktree' builds trees.
    const { createHelm } = await import(KERNEL_APP_PATH)
    const traced = createTracedTransport(baseTransport)
    const app = await withDeadline(
      createHelm({ dataDir: state.dataDir, cwd: state.repoDir, herdrTransport: traced.transport }),
      'createHelm startup',
    )
    state.app = app
    state.workflows = app.workflows
    await app.kernel.plugins.setConfig('builtin:herdr', {
      session: sessionName,
      socketPath,
      startupTimeoutMs: 30_000,
    })
    await withDeadline(app.kernel.plugins.enable('builtin:herdr'), 'enabling builtin:herdr')
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
      'profile saved and bound to the herdr runtime',
      savedProfile?.runtime?.kind === 'herdr' && savedProfile.runtime.agent === 'pi',
      JSON.stringify(savedProfile?.runtime),
    )

    // Gate command: really validate the artifact, then append one line to gate-count under
    // tempRoot — hard shell-side evidence of the Gate execution count (independent of
    // node.gate metadata, which could prove it did not run twice).
    const gateCommand =
      `test "$(wc -l < ${ARTIFACT_NAME})" -eq 3 && printf 'x\\n' >> ${shellQuote(state.gateCountPath)}`
    const gateCountLines = () => {
      const content = readFileOrEmpty(state.gateCountPath)
      return content.split('\n').filter((l) => l !== '').length
    }
    const script = buildWorkflowScript(PROFILE_ID, gateCommand)

    // ---- 6) Original run: agent(worktree+schema+gate) + resume continuation ----
    const run1 = await state.workflows.run({ script, conversationId: ROOT_CONVERSATION_ID })
    state.activeRunIds.add(run1.id)
    log(`original run: ${run1.id}`)
    const result1 = await withDeadline(state.workflows.wait(run1.id), 'original run execution (real GLM model calls)')
    state.activeRunIds.delete(run1.id)
    const summary1 = state.workflows.getRun(run1.id)
    if (summary1.status !== 'completed') {
      log(`original run node diagnostics: ${JSON.stringify(summary1.nodes ?? [])}`)
      writeFileSync(join(logsDir, 'workflow-failure.json'), JSON.stringify(summary1, null, 2))
    }

    check('original run status completed', summary1.status === 'completed', summary1.error ?? summary1.status)
    check('original run attached to root conversation #1', summary1.conversationId === ROOT_CONVERSATION_ID, String(summary1.conversationId))
    const r1 = result1 && typeof result1 === 'object' ? result1 : undefined
    check(
      'original run result first.answer === 3 (JSON handover file field)',
      r1?.first && typeof r1.first.answer === 'number' && r1.first.answer === 3,
      JSON.stringify(r1?.first),
    )
    check(
      'original run result second is a non-empty confirmation text',
      typeof r1?.second === 'string' && r1.second.trim() !== '',
      JSON.stringify(String(r1?.second ?? '').slice(0, 80)),
    )

    const nodes1 = summary1.nodes ?? []
    check(
      'original run has exactly 2 agent nodes, all done',
      nodes1.length === 2 && nodes1.every((n) => n.kind === 'agent' && n.status === 'done'),
      JSON.stringify(nodes1.map((n) => `${n.id}:${n.status}`)),
    )
    const [nodeA1, nodeB1] = nodes1
    check(
      'original run nodes share the same executionId (same Herdr pane continuation)',
      typeof nodeA1?.executionId === 'string' &&
        nodeA1.executionId !== '' &&
        nodeA1.executionId === nodeB1?.executionId,
      `agent-0=${nodeA1?.executionId} agent-1=${nodeB1?.executionId}`,
    )
    check(
      'Gate only on the first node with ok=true and gate-count at exactly one line (executed exactly once on the shell side)',
      nodeA1?.gate?.ok === true && nodeB1?.gate === undefined && gateCountLines() === 1,
      JSON.stringify({ nodeGate: nodeA1?.gate, secondNodeGate: nodeB1?.gate, gateCount: gateCountLines() }),
    )
    const wt1 = nodeA1?.worktree
    check('first node carries worktree metadata', wt1 && isAbsolute(wt1.path) && typeof wt1.branch === 'string' && wt1.branch !== '', JSON.stringify(wt1))
    check('worktree directory still present after the run settles', existsSync(wt1.path), wt1.path)
    const branchList1 = runCmd('git', ['-C', state.repoDir, 'branch', '--list', wt1.branch]).stdout.trim()
    check('worktree branch still present after the run settles', branchList1.includes(wt1.branch), branchList1 || `(not found: ${wt1.branch})`)
    const artifact1 = existsSync(join(wt1.path, ARTIFACT_NAME))
      ? readFileSync(join(wt1.path, ARTIFACT_NAME), 'utf8')
      : undefined
    check(`${ARTIFACT_NAME} inside the worktree has the real content (three lines)`, artifact1 === ARTIFACT_TEXT, JSON.stringify(artifact1))
    state.worktreePaths.push(wt1.path)

    // Real Herdr snapshot: every pane of this workflow is closed, the pre-built baseline
    // pane stays. onRunSettled has completed by the time wait returns.
    const snap1 = await withDeadline(snapshotSession(baseTransport, socketPath), 'snapshot after the original run')
    const paneStillThere =
      snap1.panes.some((p) => p.pane_id === nodeA1.executionId) ||
      snap1.agents.some((a) => a.pane_id === nodeA1.executionId)
    check(
      'original run exactly restores the pre-existing pane baseline after settling, with no new pane/tab/workspace',
      !paneStillThere && matchesBaseline(snap1),
      JSON.stringify({ baseline, actual: baselineIds(snap1) }),
    )

    // ---- 7) Strict resumeFromRunId replay (engine-fix target contract: cached prefix, zero new side effects) ----
    const countsAfterRun1 = { ...traced.counts }
    log(`RPC counts after the original run: agent.start=${countsAfterRun1['agent.start']} agent.prompt=${countsAfterRun1['agent.prompt']} (values not hardcoded; one legitimate self-heal allowed)`)

    const run2 = await state.workflows.run({ resumeFromRunId: run1.id, conversationId: ROOT_CONVERSATION_ID })
    state.activeRunIds.add(run2.id)
    log(`replay run: ${run2.id} (replayedFrom=${run1.id})`)
    const result2 = await withDeadline(state.workflows.wait(run2.id), 'replay run execution')
    state.activeRunIds.delete(run2.id)
    const summary2 = state.workflows.getRun(run2.id)

    check('replay run status completed', summary2.status === 'completed', summary2.error ?? summary2.status)
    check('replay run carries the replayedFrom marker', summary2.replayedFrom === run1.id, String(summary2.replayedFrom))

    let deepOk = true
    let deepWhy = ''
    try {
      deepStrictEqual(result2, result1)
    } catch (e) {
      deepOk = false
      deepWhy = e instanceof Error ? e.message.slice(0, 200) : String(e)
    }
    check('replay result deep-equals the original run (cached-prefix replay)', deepOk, deepWhy)

    const nodes2 = summary2.nodes ?? []
    check(
      'replay run has exactly 2 agent nodes, all done with cached=true (cache hits, not live re-runs)',
      nodes2.length === 2 && nodes2.every((n) => n.kind === 'agent' && n.status === 'done' && n.cached === true),
      JSON.stringify(nodes2.map((n) => `${n.id}:${n.status}:cached=${String(n.cached)}`)),
    )

    check(
      'replay adds zero new Herdr calls (agent.start / agent.prompt counts unchanged)',
      traced.counts['agent.start'] === countsAfterRun1['agent.start'] &&
        traced.counts['agent.prompt'] === countsAfterRun1['agent.prompt'],
      `agent.start ${countsAfterRun1['agent.start']}->${traced.counts['agent.start']}; agent.prompt ${countsAfterRun1['agent.prompt']}->${traced.counts['agent.prompt']}`,
    )
    check('replay does not re-run the Gate (gate-count still exactly one line)', gateCountLines() === 1, `gateCount=${gateCountLines()}`)

    const snap2 = await withDeadline(snapshotSession(baseTransport, socketPath), 'snapshot after the replay run')
    check(
      'replay run keeps pre-existing panes after settling, with zero new pane/tab/workspace',
      matchesBaseline(snap2),
      JSON.stringify({ baseline, actual: baselineIds(snap2) }),
    )

    state.success = true
  } catch (err) {
    runError = err
  }

  // ---- Cleanup (bounded budget; any failure => overall FAIL with the scene preserved) ----
  const problems = await cleanup(state, args)
  const ok = runError === null && state.success && problems.length === 0
  const failed = results.filter((r) => !r.ok).length

  if (runError !== null) {
    log(`HERDR-SMOKE: FAIL — ${runError instanceof Error ? runError.message : String(runError)}`)
  }
  for (const p of problems) log(`CLEANUP-FAIL ${p}`)
  log(`== helm herdr-smoke summary == PASS ${results.length - failed} / FAIL ${failed}${problems.length > 0 ? ` / cleanup failures ${problems.length}` : ''}`)
  log(`HERDR-SMOKE: ${ok ? 'PASS' : 'FAIL'}`)
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok, passed: results.length - failed, failed, cleanupFailures: problems, results })}\n`)
  }
  if (!ok) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// Cleanup: only touch resources we created; any failure counts as overall FAIL and
// preserves the scene and logs
// ---------------------------------------------------------------------------

async function cleanup(state, args) {
  const problems = []
  const step = (label, ms, fn) =>
    withBudget(fn(), ms, label).catch((e) => {
      problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    })

  // 1) Best-effort abort of in-flight runs (the timeout/failure path must not leave fake running entries)
  if (state.workflows && state.activeRunIds.size > 0) {
    for (const runId of [...state.activeRunIds]) {
      await step(`abort run ${runId}`, 5_000, () => state.workflows.abort(runId))
    }
  }

  // 2) Close the kernel (plugin teardown; already-settled runs never block)
  if (state.app) {
    await step('app.close', 10_000, () => state.app.close())
  }

  // 3) Stop only the headless session we created (explicit socket addressing via the same isolated env; the main Herdr is never touched)
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
      problems.push(`herdr server pid=${state.herdr.proc.pid} could not be terminated in the end`)
    }
  }

  if (state.success && problems.length === 0) {
    // 4) Success path: first verify the worktree dir/branch is really present (the
    //    acceptance assertions already passed), then clean up the worktrees we created;
    //    removal is allowed only when the git common-dir belongs to this temp repo.
    for (const wtPath of [...new Set(state.worktreePaths)]) {
      if (!existsSync(wtPath)) continue
      try {
        const raw = runCmd('git', ['-C', wtPath, 'rev-parse', '--git-common-dir'], { timeoutMs: 10_000 }).stdout.trim()
        const commonDir = isAbsolute(raw) ? raw : resolve(wtPath, raw)
        const expected = resolve(state.repoDir, '.git')
        if (commonDir !== expected) {
          throw new SmokeError(`refusing to remove a worktree outside this temp repo: ${wtPath} (common-dir=${commonDir}, expected ${expected})`)
        }
        runCmd('git', ['-C', state.repoDir, 'worktree', 'remove', '--force', wtPath], { timeoutMs: 15_000 })
        log(`cleaned up worktree: ${wtPath}`)
      } catch (e) {
        problems.push(`worktree cleanup ${wtPath}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (problems.length > 0) {
      log(`cleanup failed, scene preserved: ${state.tmpRoot}`)
      if (state.herdr) log(`herdr server log: ${state.herdr.logPath}`)
    } else if (!args.keepTmp) {
      try {
        rmSync(state.tmpRoot, { recursive: true, force: true })
        log(`cleaned up temp root: ${state.tmpRoot}`)
      } catch (e) {
        problems.push(`temp root cleanup: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      log(`--keep-tmp: temp root preserved at ${state.tmpRoot} (herdr log: ${state.herdr?.logPath})`)
    }
  } else if (state.tmpRoot !== '') {
    // Any failure: never delete logs or the scene; print the diagnostic entry points
    log(`failure scene preserved: ${state.tmpRoot}`)
    if (state.herdr) log(`herdr server log: ${state.herdr.logPath}`)
  }

  return problems
}

main().catch((err) => {
  process.stderr.write(`HERDR-SMOKE: FAIL — ${err instanceof Error ? err.message : String(err)}\n`)
  if (err instanceof Error && err.stack) process.stderr.write(`${tail(err.stack, 12)}\n`)
  process.exit(1)
})
