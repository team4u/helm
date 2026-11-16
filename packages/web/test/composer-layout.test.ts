import test from 'node:test'
import assert from 'node:assert/strict'
import { canConfigureSessionEnv, envDraftError, envDraftOnNodeChange, envDraftUnchanged, formatEnvSubtitle } from '../src/conversation/composer-model.js'

const e = (kind: string) => ({ kind })

test('canConfigureSessionEnv：空会话或无 handoff 的 /reset 后未再发消息才允许配置起始环境', { timeout: 60_000 }, () => {
  // 空会话（idle 且无任何对话条目）允许。
  assert.equal(canConfigureSessionEnv([], 'idle'), true)
  // 详情未加载完不允许（避免加载间隙误展示可配状态）。
  assert.equal(canConfigureSessionEnv(undefined, 'idle'), false)
  // 任一实质性对话条目即锁定（SDK 真实 kind 用连字符，兼容旧下划线拼写）。
  assert.equal(canConfigureSessionEnv([e('helm.input')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.user')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.assistant')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.tool-call')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.tool-result')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.tool_call')], 'idle'), false)
  // 压缩属于实质上下文：不能变成环境解锁入口。
  assert.equal(canConfigureSessionEnv([e('pi.reset'), e('pi.compaction')], 'idle'), false)
  // 执行中 / 待审批一律禁止。
  assert.equal(canConfigureSessionEnv([], 'working'), false)
  assert.equal(canConfigureSessionEnv([], 'blocked'), false)
  // 含历史对话但末尾 pi.reset（无 handoff）且之后无新对话 -> 重新可配。
  assert.equal(
    canConfigureSessionEnv([e('helm.input'), e('pi.assistant'), e('pi.reset')], 'idle'),
    true,
  )
  // pi.reset 之后又有新 helm.input -> 锁定。
  assert.equal(
    canConfigureSessionEnv([e('helm.input'), e('pi.reset'), e('helm.input')], 'idle'),
    false,
  )
  // 带 handoff 的 reset：data.handoff 为非空字符串时继续锁定（新上下文继承旧环境叙事）。
  assert.equal(
    canConfigureSessionEnv([{ kind: 'pi.reset', data: { handoff: '继续之前的任务环境' } }], 'idle'),
    false,
  )
  // data.handoff 为空字符串（普通 reset）不锁定。
  assert.equal(
    canConfigureSessionEnv([{ kind: 'pi.reset', data: { handoff: '' } }], 'idle'),
    true,
  )
  // SDK 也可能把 handoff 写进 model（[UserMessage] 文本，见 pi-durable README/entries.d.ts）。
  assert.equal(
    canConfigureSessionEnv(
      [{ kind: 'pi.reset', data: null, model: [{ role: 'user', content: '交接摘要：节点 gpu-box' }] }],
      'idle',
    ),
    false,
  )
  // model 内分段文本形态同样算 handoff。
  assert.equal(
    canConfigureSessionEnv(
      [{ kind: 'pi.reset', model: [{ role: 'user', content: [{ type: 'text', text: '交接摘要' }] }] }],
      'idle',
    ),
    false,
  )
  // 非 user 角色的 model 不构成 handoff。
  assert.equal(
    canConfigureSessionEnv([{ kind: 'pi.reset', model: [{ role: 'assistant', content: 'x' }] }], 'idle'),
    true,
  )
  // 非对话条目（如 helm.notice）不影响空状态判定。
  assert.equal(canConfigureSessionEnv([e('helm.notice')], 'idle'), true)
})

test('起始环境草稿：跨节点切换不沿用旧 cwd，校验拒绝空/相对路径', { timeout: 60_000 }, () => {
  // 未改节点：cwd 草稿保留。
  assert.deepEqual(
    envDraftOnNodeChange({ nodeId: 'local', cwd: '/root/code/helm' }, 'local'),
    { nodeId: 'local', cwd: '/root/code/helm' },
  )
  // 跨节点切换：清空 cwd 草稿，绝不继承旧节点路径。
  assert.deepEqual(
    envDraftOnNodeChange({ nodeId: 'local', cwd: '/root/code/helm' }, 'gpu-box'),
    { nodeId: 'gpu-box', cwd: '' },
  )
  // 草稿校验：空目录与相对路径拒绝；POSIX 与 Windows 绝对路径故行。
  assert.match(envDraftError({ nodeId: 'local', cwd: '' }) ?? '', /请填写/)
  assert.match(envDraftError({ nodeId: 'local', cwd: '  ' }) ?? '', /请填写/)
  assert.match(envDraftError({ nodeId: 'local', cwd: 'relative/path' }) ?? '', /绝对路径/)
  assert.equal(envDraftError({ nodeId: 'local', cwd: '/root/code/helm' }), null)
  assert.equal(envDraftError({ nodeId: 'win-node', cwd: 'C:\\workspace\\helm' }), null)
  assert.equal(envDraftError({ nodeId: 'win-node', cwd: 'C:/workspace/helm' }), null)
  // 与当前坐标比对：nodeId 缺省视为 local。
  assert.equal(envDraftUnchanged({ nodeId: 'local', cwd: '/a' }, undefined, '/a'), true)
  assert.equal(envDraftUnchanged({ nodeId: 'local', cwd: '/a' }, 'local', '/a'), true)
  assert.equal(envDraftUnchanged({ nodeId: 'gpu-box', cwd: '/a' }, 'local', '/a'), false)
  assert.equal(envDraftUnchanged({ nodeId: 'local', cwd: '/b' }, 'local', '/a'), false)
})

test('formatEnvSubtitle：本机省略 @local，远端带 @node 前缀，tooltip 给全量信息', { timeout: 60_000 }, () => {
  // 本机：省略 @local，显示 profileId · cwd 尾部两段。
  assert.deepEqual(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'local', cwd: '/root/code/helm' }), {
    text: 'assistant · code/helm',
    tooltip: '智能体：assistant · 节点：local · 工作目录：/root/code/helm',
  })
  // nodeId 缺省视为 local。
  assert.equal(formatEnvSubtitle({ profileId: 'assistant', cwd: '/root/code/helm' }).text, 'assistant · code/helm')
  // 远端节点：@gpu-box:tail。
  assert.deepEqual(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'gpu-box', cwd: '/home/user/code/helm' }), {
    text: 'assistant · @gpu-box:code/helm',
    tooltip: '智能体：assistant · 节点：gpu-box · 工作目录：/home/user/code/helm',
  })
  // 空 cwd：本机只显示 profileId，远端显示 @node。
  assert.equal(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'local', cwd: '' }).text, 'assistant')
  assert.equal(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'gpu-box', cwd: '' }).text, 'assistant · @gpu-box')
  // 尾部段数可配。
  assert.equal(formatEnvSubtitle({ profileId: 'p', cwd: '/a/b/c/d', segments: 3 }).text, 'p · b/c/d')
  // 空 cwd 的 tooltip 显示 (未设置)。
  assert.equal(
    formatEnvSubtitle({ profileId: 'p', cwd: '' }).tooltip,
    '智能体：p · 节点：local · 工作目录：(未设置)',
  )
})

test('formatEnvSubtitle：Windows 反斜杠与根路径兼容，compact 模式仅保留远端节点身份', { timeout: 60_000 }, () => {
  // Windows 反斜杠拆段后仍取尾部两段。
  assert.equal(
    formatEnvSubtitle({ profileId: 'p', nodeId: 'win-node', cwd: 'C:\\Users\\dev\\work\\helm' }).text,
    'p · @win-node:work/helm',
  )
  // 混合分隔符。
  assert.equal(formatEnvSubtitle({ profileId: 'p', cwd: 'C:\\a/b/c' }).text, 'p · b/c')
  // 根路径不丢段：'/' 保留为一段；'C:\\' 拆后保留盘符段（工具目录截短只影响展示，tooltip 恒全量）。
  assert.equal(formatEnvSubtitle({ profileId: 'p', cwd: '/' }).text, 'p · /')
  assert.equal(formatEnvSubtitle({ profileId: 'p', nodeId: 'win', cwd: 'C:\\' }).text, 'p · @win:C:')
  // compact：远端仅 @node，本机空串（调用方不渲染）；tooltip 始终全量。
  assert.deepEqual(formatEnvSubtitle({ profileId: 'p', nodeId: 'gpu-box', cwd: '/x/y', compact: true }), {
    text: '@gpu-box',
    tooltip: '智能体：p · 节点：gpu-box · 工作目录：/x/y',
  })
  assert.equal(formatEnvSubtitle({ profileId: 'p', nodeId: 'local', cwd: '/x/y', compact: true }).text, '')
})
