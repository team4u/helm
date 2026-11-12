import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { canConfigureSessionEnv, envDraftError, envDraftOnNodeChange, envDraftUnchanged, formatEnvSubtitle } from '../src/conversation/composer-model.js'

// 读取源码后统一换行（Windows checkout 下 autocrlf 会产生 CRLF，正则不得依赖 LF）
const source = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const responsive = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

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

test('会话顶栏极简：顶栏不显重复的状态/loading徽章（执行反馈收敛在时间线与输入区），reset 为红色危险项且先确认', { timeout: 60_000 }, () => {
  // 顶栏不渲染状态/loading徽章（由下方时间线与输入区提供执行反馈，避免顶栏重复展示）。
  assert.doesNotMatch(paneSource, /statusMeta/)
  const statusBadgeCount = [...paneSource.matchAll(/className=\{`badge \$\{statusMeta\.badge\}`\}/g)].length
  assert.equal(statusBadgeCount, 0, '顶栏不渲染状态徽章')
  assert.doesNotMatch(paneSource, /<span className="badge-label">/)
  // 环境副标题只读（无点击编辑）：桌面/紧凑双形态共存，不带 onClick。
  assert.match(paneSource, /<span className="pane-cwd-subtitle" title=\{envSubtitle\.tooltip\}>\s*<span className="env-subtitle-full">\{envSubtitle\.text\}<\/span>/)
  const subtitleMatch = /<span className="pane-cwd-subtitle[\s\S]*?<\/span>\s*<\/div>/.exec(paneSource)
  assert.ok(subtitleMatch !== null)
  assert.doesNotMatch(subtitleMatch[0], /onClick/)
  // compact 与 reset 收纳进更多菜单；reset 危险样式 + 分隔线 + ConfirmDialog 确认。
  const moreMenuSlice = paneSource.slice(paneSource.indexOf('pane-more-popover'), paneSource.indexOf('</header>'))
  assert.match(moreMenuSlice, /conversationsApi\.compact\(conversationId\)/)
  assert.match(moreMenuSlice, /popover-item-danger/)
  assert.match(moreMenuSlice, /popover-separator/)
  const resetIdx = moreMenuSlice.indexOf('popover-item-danger')
  const confirmIdx = moreMenuSlice.indexOf("setConfirmAction('reset')")
  assert.ok(resetIdx > 0 && confirmIdx > resetIdx, '危险样式与确认属于 reset 项')
  assert.match(paneSource, /conversationsApi\.reset\(conversationId\)/)
  assert.match(paneSource, /confirmAction === 'reset'/)
  assert.match(moreMenuSlice, /重命名会话/)
  // 顶栏不再常驻精简/重置独立按钮。
  const actionsSlice = paneSource.slice(paneSource.indexOf('pane-actions'), paneSource.indexOf('pane-more-menu'))
  assert.doesNotMatch(actionsSlice, /精简上下文/)
  assert.doesNotMatch(actionsSlice, /重置上下文/)
  // Escape 关闭更多菜单后焦点回触发按钮。
  assert.match(paneSource, /moreButtonRef\.current\?\.focus\(\)/)
})

test('新话题继承当前会话环境：远端会话内新建话题继续当前节点与目录', { timeout: 60_000 }, () => {
  const threadSlice = paneSource.slice(paneSource.indexOf("'new-thread'"), paneSource.indexOf('已新建对话'))
  assert.match(threadSlice, /profileId: conversation\.profileId/)
  assert.match(threadSlice, /nodeId: currentNodeId/)
  assert.match(threadSlice, /cwd: conversation\.cwd/)
})

test('Composer 空会话起始环境配置条：草稿式编辑，跨节点清空 cwd，阻塞未保存发送', { timeout: 60_000 }, () => {
  // 用 canConfigureSessionEnv 门控；详情未加载/分页中不会误判（undefined 即禁止）。
  assert.match(source, /detail\?\.nextCursor && !detail\.entries\.some\(\(entry\) => entry\.kind === 'pi.reset'\)/)
  assert.match(source, /canConfigureSessionEnv\(detailEntries, conversation\.status\)/)
  // 节点选择只进入草稿：跨节点经 envDraftOnNodeChange 清空 cwd，绝不沿用旧节点路径。
  assert.match(source, /envDraftOnNodeChange\(prev, e\.target\.value\)/)
  assert.doesNotMatch(source, /onBlur=\{\(\) => void save/)
  // 保存一次提交 nodeId + cwd，以 PATCH 返回值确认。
  assert.match(source, /conversationsApi\.patch\(conversation\.id, \{ nodeId: draft\.nodeId, cwd: draft\.cwd\.trim\(\) \}\)/)
  // 保存失败保留草稿并显式报错。
  assert.match(source, /role="alert"/)
  // 未保存/保存中阻塞发送：发送函数自身与按钮同时拦截（覆盖 Enter）。
  assert.match(source, /if \(envBlockedRef\.current\) \{[\s\S]*?请先保存或取消起始环境修改[\s\S]*?return\r?\n    \}/)
  assert.match(source, /envBlocker\.blocked \|\| text\.trim\(\) === ''/)
  // 发送中禁止改环境：SessionEnvBar 接收 sendBlocked。
  assert.match(source, /sendBlocked=\{sendInFlight\}/)
  // 按会话 id 隔离草稿。
  assert.match(source, /key=\{`env-\$\{conversation\.id\}`\}/)
  assert.match(source, /aria-label="会话执行节点"/)
  assert.match(source, /aria-label="会话工作目录"/)
  assert.match(source, /首条消息发送后锁定/)
  // 样式：轻量无框，窄屏隐藏提示防溢出；select 不再被 .input 默认 padding 裁切。
  assert.match(styles, /\.composer-env-bar \{[^}]*flex-wrap: wrap;/)
  assert.match(styles, /\.input\.composer-env-select \{[^}]*padding: 0 6px;[^}]*line-height: normal;/)
  assert.match(styles, /\.pane-cwd-subtitle \{[^}]*background: transparent;[^}]*border: none;[^}]*padding: 0;/)
  const narrow = responsive.slice(responsive.indexOf('@container (max-width: 680px)'), responsive.indexOf('@container (max-width: 450px)'))
  assert.match(narrow, /\.composer-env-hint \{ display: none; \}/)
  // 输入控件字号与正文保持统一，不强行放大到 16px（无论桌面分屏还是移动端均不突兀）
  assert.doesNotMatch(narrow, /font-size:\s*16px/)
  assert.doesNotMatch(responsive, /\.composer-env-select[^{]*\{[^}]*font-size:\s*16px/)
})

test('侧边栏远端节点标记：非本机会话行展示 @nodeId', { timeout: 60_000 }, () => {
  assert.match(sidebarSource, /conv\.nodeId && conv\.nodeId !== 'local' && <RemoteNodeTag nodeId=\{conv\.nodeId\} \/>/)
  assert.match(sidebarSource, /title=\{`运行节点：\$\{nodeId\}`\}/)
})

test('工具栏仅保留左右两组，模型归入左组，避免三个子项落入两列后换行', { timeout: 60_000 }, () => {
  assert.match(source, /className="composer-toolbar">\s*<div className="composer-toolbar-left">/)
  const leftGroup = source.slice(source.indexOf('className="composer-toolbar-left"'), source.indexOf('className="composer-toolbar-right"'))
  assert.match(leftGroup, /<ModelPicker conversation=\{conversation\} \/>/)
  assert.match(source, /className="composer-model-label"/)
  // 思考档位已并入模型浮层，工具栏不再有独立 <select>
  assert.doesNotMatch(source, /composer-thinking-select/)
  assert.match(source, /composer-thinking-row/)
  assert.match(styles, /\.composer-pills \{[^}]*overflow-x: auto;/)
  assert.match(styles, /\.composer-toolbar-right \{ justify-content: flex-end;/)
})

test('思考档位合并进模型浮层：按钮组切换，当前档位随模型短名展示', { timeout: 60_000 }, () => {
  assert.match(source, /composer-model-level/)
  assert.match(source, /void pickThinking\(''\)/)
  assert.match(source, /void pickThinking\(level\)/)
  // 浮层内档位行为分段按钮组（默认 + 各档位），主按钮态表达当前选择
  const popoverSlice = source.slice(source.indexOf('composer-thinking-row'))
  assert.match(popoverSlice, /跟随模型 \/ Profile 默认档位/)
})

test('textarea 单行起步并自动长高：rows=1，发完回归单行', { timeout: 60_000 }, () => {
  assert.match(source, /rows=\{1\}/)
  assert.match(source, /autoGrow/)
  assert.match(styles, /\.composer-textarea\s*\{[^}]*min-height:\s*36px/)
  assert.match(styles, /\.composer-textarea\s*\{[^}]*overflow-y:\s*auto/)
})

test('窄面板单行工具栏：取消思考下拉独占行，配置与发送同排', { timeout: 60_000 }, () => {
  const narrow = responsive.slice(responsive.indexOf('@container (max-width: 680px)'), responsive.indexOf('@container (max-width: 450px)'))
  assert.match(styles, /\.composer-toolbar\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/)
  assert.doesNotMatch(narrow, /composer-thinking-select/)
  // 模型选择器不再独占整行（grid-column: 1 / -1 已移除）
  assert.doesNotMatch(narrow, /grid-column: 1 \/ -1/)
  assert.match(narrow, /\.composer-action-label \{ display: none;/)
  assert.doesNotMatch(responsive, /\.composer-toolbar \{[^}]*flex-wrap: wrap/)
})

test('发送 / 停止按钮图标化：无文字仍可辨识（title + aria-label）', { timeout: 60_000 }, () => {
  assert.match(source, /btn-send/)
  assert.match(source, /aria-label=\{editingEntryId !== null \? '更新并重新生成' : uploading > 0 \? `上传中 \(\$\{uploading\}\)` : '发送'\}/)
  assert.match(source, /aria-label="停止当前执行"/)
  assert.match(styles, /\.btn-send\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*border-radius: 50%/)
})

test('移动端插件入口收进会话工具菜单，挂件默认折叠', { timeout: 60_000 }, () => {
  assert.match(source, /widgetsExpanded/)
  assert.match(source, /<details className="composer-extras"/)
  assert.match(source, /aria-label="会话工具"/)
  assert.match(source, /widgets\.length > 0 && \(!isMobile \|\| widgetsExpanded\)/)
  assert.doesNotMatch(source, /composer-widgets-toggle/)
})

test('ModelPicker 内置原生动态模型刷新按钮，调用 assetsApi.refreshModels', { timeout: 60_000 }, () => {
  assert.match(source, /assetsApi\.refreshModels\(\)/, '必须调用通用的 assetsApi.refreshModels')
  assert.match(source, /store\.refreshAssets\(\)/, '刷新完成后需同步更新前端资产')
  assert.match(source, /composer-model-refresh-btn/, '刷新按钮具有专属类名')
  assert.match(source, /aria-label="刷新动态模型目录"/, '具备无障碍描述')
  assert.match(source, /name="rotate-cw"/, '使用 rotate-cw 线性图标')
})
