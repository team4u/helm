/**
 * 「默认后台协同」文档 / Profile 协作提示契约锁定测试（纯静态资产断言）。
 *
 * 锁定的契约（docs/plugins/workflow.md「默认后台协同：按会话归属判定生命周期」）：
 * 1. 生命周期缺省按当前会话归属判定：人类直连会话（ownedBy human）缺省后台；
 *    自动化会话（ownedBy helm/bot）缺省同步；自动化会话显式 background:true 被拒绝
 *    （显式报错携带归属事实，不静默降级）。
 * 2. profileId / agentType 只选择目标执行体（原生 Profile 或外部运行时），不参与
 *    生命周期判定。
 * 3. 四类执行体区别如实陈述：原生 Profile 子会话 / 外部 Herdr Profile / SuperAgent
 *    Worker（dispatch_worker 插件专属非阻塞协议，独立 turn_settled → 中枢汇报链，
 *    不是 subagent 的 background 参数、绝不同步等待）/ fork 与人工会话。
 * 4. 后台完成自动幂等汇报（requestId helm:subagent-report:<runId>）；协作提示明确
 *    禁止 sleep 轮询等待后台结果。
 * 5. SubagentWorkflow 模型工具与 subagent 同一归属策略；CLI/动作 workflows run 是
 *    另一入口（缺省启动即返回、--wait 才同步），不得写成同一参数。
 * 6. 诚实性边界：文档不得宣称对 Herdr 外部窗格支持 steer 插话（仅可写待能力）；
 *    DSL agent() 不提供 background 选项。
 *
 * 实现阶段测试规划（归属缺省策略在 builtin:workflow 落地时由实现方在 kernel
 * 集成测试补齐，本文件不重复实现细节断言）：
 * - human-owned 会话缺省走 startBackgroundAgent（notifyParentOnSettle），立即返回
 *   runId + execution；
 * - ownedBy helm/bot 会话缺省同步等待 spawnAgent 真实结果；
 * - 自动化会话显式 background:true 返回显式错误信封（isError + 归属事实），不静默
 *   降级为同步；
 * - SubagentWorkflow 工具同策略：human 后台启动即返回 running summary 且终态汇报
 *   恰好一次，自动化同步返回完整 summary；
 * - 汇报幂等 / 重启补发已由 worktree-runtime.integration.test.ts、
 *   background-subagent.test.ts、background-restart.integration.test.ts 覆盖。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HELM_CLI_WORKFLOWS_AND_AGENTS_MD } from '../src/builtin-plugins/profile/assets.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function readDoc(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf-8')
}

const workflowDoc = readDoc(join('docs', 'plugins', 'workflow.md'))
const dslGuide = readDoc(join('docs', 'workflows', 'dsl-guide.md'))
const superagentDoc = readDoc(join('docs', 'plugins', 'superagent.md'))
const herdrDoc = readDoc(join('docs', 'plugins', 'herdr.md'))
const cliReference = readDoc(join('docs', 'cli', 'reference.md'))

test('workflow 插件文档：生命周期缺省按会话归属判定（human 缺省后台 / 自动化缺省同步 / 显式拒绝）', { timeout: 60_000 }, () => {
  assert.ok(workflowDoc.includes('默认后台协同：按会话归属判定生命周期'), '缺「默认后台协同」章节')
  assert.ok(workflowDoc.includes('人类直连会话缺省后台'), '缺 human 缺省后台陈述')
  assert.ok(/自动化会话[^\n。]*缺省同步/.test(workflowDoc), '缺自动化会话缺省同步陈述')
  assert.ok(/显式 `background: true` 显式拒绝|显式 `background: true` 被拒绝/.test(workflowDoc), '缺自动化会话显式 background:true 拒绝陈述')
  assert.ok(workflowDoc.includes('不参与生命周期判定'), '缺 profileId/agentType 只选择目标执行体的边界陈述')
  assert.ok(/`agentType` 只选择目标执行体/.test(workflowDoc), '工具表缺 agentType 边界陈述')
})

test('workflow 插件文档：四类执行体区别（原生 / 外部 Herdr / SuperAgent Worker / fork 人工）', { timeout: 60_000 }, () => {
  assert.ok(workflowDoc.includes('四类执行体的区别'), '缺四类执行体区别表')
  assert.ok(workflowDoc.includes('原生 Profile 子会话'), '缺原生 Profile 行')
  assert.ok(workflowDoc.includes('外部 Herdr Profile'), '缺外部 Herdr Profile 行')
  assert.ok(workflowDoc.includes('SuperAgent Worker'), '缺 SuperAgent Worker 行')
  assert.ok(workflowDoc.includes('fork / 人工会话'), '缺 fork/人工会话行')
  // dispatch_worker 边界：插件专属非阻塞协议，独立汇报链，不是 subagent 的 background 参数。
  assert.ok(workflowDoc.includes('不是 `subagent` 的 `background` 参数'), '缺 dispatch_worker 与 background 参数的边界陈述')
  assert.ok(/turn_settled[^\n。]*中枢/.test(workflowDoc), '缺 dispatch_worker 独立 turn_settled 汇报链陈述')
})

test('workflow 插件文档：后台自动幂等汇报 + 禁止 sleep 轮询 + workflows run 入口区分', { timeout: 60_000 }, () => {
  assert.ok(workflowDoc.includes('helm:subagent-report:<runId>'), '缺幂等汇报 requestId 陈述')
  assert.ok(workflowDoc.includes('禁止 sleep 轮询'), '缺禁止 sleep 轮询陈述')
  assert.ok(workflowDoc.includes('不同参数、不同入口'), '缺 workflows run 与模型工具 background 的入口区分')
  assert.ok(cliReference.includes('--wait'), 'CLI 参考缺 --wait 条目')
  assert.ok(/workflows run[^\n]*--wait/.test(cliReference), 'CLI 参考缺 workflows run --wait 说明')
})

test('Profile 协作提示（helm-cli 技能 references/workflows-and-agents.md）：归属缺省、禁 sleep 轮询、@ 点名认知约定', { timeout: 60_000 }, () => {
  const ref = HELM_CLI_WORKFLOWS_AND_AGENTS_MD
  assert.ok(ref.includes('人类直连会话缺省后台'), '协作提示缺 human 缺省后台')
  assert.ok(/缺省同步等待最终结果/.test(ref), '协作提示缺自动化缺省同步')
  assert.ok(ref.includes('显式 `background: true` 会被拒绝'), '协作提示缺显式拒绝陈述')
  assert.ok(ref.includes('不参与生命周期判定'), '协作提示缺 agentType 边界')
  assert.ok(ref.includes('不要用 sleep 或轮询等待后台结果'), '协作提示缺禁止 sleep 轮询')
  assert.ok(ref.includes('汇报幂等'), '协作提示缺汇报幂等陈述')
  assert.ok(ref.includes('认知约定'), '协作提示缺 @ 点名认知约定陈述')
  assert.ok(/SubagentWorkflow[^\n]*归属/.test(ref), '协作提示缺 SubagentWorkflow 归属策略陈述')
  assert.ok(/`--wait` 才同步/.test(ref), '协作提示缺 workflows run --wait 入口区分')
})

test('Profile 协作提示：dispatch_worker 插件专属非阻塞边界与 steer 待能力边界', { timeout: 60_000 }, () => {
  const ref = HELM_CLI_WORKFLOWS_AND_AGENTS_MD
  assert.ok(ref.includes('插件专属的非阻塞 Worker 协议'), '缺 dispatch_worker 插件专属陈述')
  assert.ok(ref.includes('绝不同步等待'), '缺 dispatch_worker 绝不同步等待陈述')
  assert.ok(ref.includes('独立 turn_settled'), '缺 dispatch_worker 独立汇报链陈述')
  assert.ok(ref.includes('不是 `subagent` 的 `background` 参数'), '缺 dispatch_worker 与 background 参数边界')
  // steer 边界：对外部窗格只允许「不支持（待能力）」表述，不允许宣称支持。
  assert.ok(ref.includes('不支持 steer 插话（待能力）'), '缺外部窗格 steer 待能力陈述')
})

test('superagent 插件文档：dispatch_worker 边界（非通用 background、独立汇报链、Worker 归属同步缺省）', { timeout: 60_000 }, () => {
  assert.ok(superagentDoc.includes('与 `builtin:workflow` `subagent` 的 `background` 参数无关'), '缺与 subagent background 参数的边界')
  assert.ok(superagentDoc.includes('绝不同步等待模型回合'), '缺绝不同步等待陈述')
  assert.ok(/turn_settled[^\n。]*中枢汇报链/.test(superagentDoc), '缺独立 turn_settled 汇报链陈述')
  assert.ok(/Worker 会话[^\n。]*缺省同步/.test(superagentDoc), '缺 Worker 会话按归属缺省同步陈述')
})

test('herdr 插件文档：不宣称外部窗格 steer（仅待能力表述），且不改变生命周期缺省', { timeout: 60_000 }, () => {
  assert.ok(herdrDoc.includes('对外部窗格不支持 steer 插话（待能力）'), '缺外部窗格 steer 待能力边界')
  // herdr 文档中 steer 的全部出现都必须是「不支持/待能力」边界句，不得出现支持性宣称。
  const steerSentences = herdrDoc.split(/(?<=。)|\n/).filter((s) => s.includes('steer'))
  assert.ok(steerSentences.length > 0, '应有至少一句 steer 边界表述')
  for (const sentence of steerSentences) {
    assert.ok(sentence.includes('不支持'), `steer 相关句子必须是否定边界句（实际：「${sentence.trim()}」）`)
  }
  assert.ok(herdrDoc.includes('外部运行时也不改变派生方会话的生命周期缺省'), '缺外部运行时不改变生命周期缺省陈述')
})

test('DSL 手册：agent() 无 background 选项；后台策略在工具层与 CLI 入口的区分陈述', { timeout: 60_000 }, () => {
  assert.ok(dslGuide.includes('没有也不接受 `background` 选项'), '缺 agent() 同步节点语义陈述')
  // 可用键固定列表不得混入 background。
  const knownKeys = dslGuide.match(/可用键固定为 `([^`]+)`/)?.[1] ?? ''
  assert.notEqual(knownKeys, '', '未找到 agent() 可用键固定列表')
  assert.ok(!knownKeys.split(',').map((k) => k.trim()).includes('background'), `agent() 可用键不得含 background（实际：${knownKeys}）`)
  assert.ok(/三个入口互不混同/.test(dslGuide), '缺三入口区分陈述')
})
