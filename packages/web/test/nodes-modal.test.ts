import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildNodeConnectGuide,
  formatBytes,
  formatUptime,
  formatUsage,
  nodeOptionLabel,
  NODE_ID_PATTERN,
  validateNodeIdInput,
} from '../src/modals/nodes-modal-model.js'

const nodesModalSource = readFileSync(new URL('../src/modals/NodesModal.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
const paletteSource = readFileSync(new URL('../src/modals/CommandPaletteModal.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const profileEditorSource = readFileSync(new URL('../src/modals/ProfileEditorModal.tsx', import.meta.url), 'utf8')
const storeProviderSource = readFileSync(new URL('../src/lib/HelmStoreProvider.tsx', import.meta.url), 'utf8')

test('节点 ID 校验：空值、保留字 local、非法字符与合法输入', { timeout: 60_000 }, () => {
  assert.deepEqual(validateNodeIdInput('   '), { ok: false, error: '请输入节点 ID' })
  assert.deepEqual(validateNodeIdInput('local'), {
    ok: false,
    error: 'local 是内建本机节点，无需签发接入令牌',
  })
  assert.deepEqual(validateNodeIdInput('-bad'), {
    ok: false,
    error: '节点 ID 需以字母或数字开头，仅含字母、数字、. _ -，最长 128 字符',
  })
  assert.deepEqual(validateNodeIdInput('bad name!'), {
    ok: false,
    error: '节点 ID 需以字母或数字开头，仅含字母、数字、. _ -，最长 128 字符',
  })
  assert.equal(NODE_ID_PATTERN.test('a'.repeat(128)), true)
  assert.equal(NODE_ID_PATTERN.test('a'.repeat(129)), false)
  // trim 后合法。
  assert.deepEqual(validateNodeIdInput('  macbook-pro  '), { ok: true, nodeId: 'macbook-pro' })
  assert.deepEqual(validateNodeIdInput('gpu.box_01'), { ok: true, nodeId: 'gpu.box_01' })
})

test('接入命令生成：start -d 一键接入 / 前台 connect 调试 / 服务安装 / 诊断', { timeout: 60_000 }, () => {
  const guide = buildNodeConnectGuide('http://192.168.1.10:3202', {
    nodeId: 'gpu-box',
    token: 'gpu-box:secret123',
  })
  // connect 前台常驻（Ctrl/Cmd+C 才退出），用 && 串联后续命令永远不会执行；
  // 一键接入改用 start -d：detach 路径支持 --token 绑定身份，且子进程 argv 不含令牌。
  assert.equal(guide.oneLineCommand, 'helm-node start -d --hub http://192.168.1.10:3202 --token gpu-box:secret123')
  // connect 保留为前台调试命令（前台常驻，非接入主路径）。
  assert.equal(guide.connectCommand, 'helm-node connect http://192.168.1.10:3202 --token gpu-box:secret123')
  // start -d（无令牌）仅复用磁盘已绑定身份启动守护。
  assert.equal(guide.startDaemonCommand, 'helm-node start -d')
  assert.ok(!guide.oneLineCommand.includes('&&'), '一键接入命令不得用 && 串联前台 connect')
  assert.equal(guide.serviceInstallCommand, 'helm-node service install')
  assert.equal(guide.doctorCommand, 'helm-node doctor')
})

test('容量与时长格式化', { timeout: 60_000 }, () => {
  assert.equal(formatBytes(undefined), '--')
  assert.equal(formatBytes(-1), '--')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KiB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MiB')
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0 GiB')
  assert.equal(formatUptime(undefined), '--')
  assert.equal(formatUptime(30), '0 分钟')
  assert.equal(formatUptime(90 * 60), '1 小时 30 分钟')
  assert.equal(formatUptime(26 * 3600), '1 天 2 小时')
  assert.equal(formatUptime(3 * 86400 + 3600), '3 天 1 小时')
})

test('占用量计算：used / percent / label，缺失或非法返回 null', { timeout: 60_000 }, () => {
  assert.equal(formatUsage(undefined, 100), null)
  assert.equal(formatUsage(100, undefined), null)
  assert.equal(formatUsage(120, 100), null, 'free 超过 total 非法')
  const usage = formatUsage(2 * 1024 ** 3, 8 * 1024 ** 3)
  assert.ok(usage)
  assert.equal(usage.usedBytes, 6 * 1024 ** 3)
  assert.equal(usage.percent, 75)
  assert.equal(usage.label, '6.0 GiB / 8.0 GiB（75%）')
})

test('节点选项文案：本机 / 在线 / 离线标注', { timeout: 60_000 }, () => {
  assert.equal(nodeOptionLabel({ id: 'local', kind: 'local', online: true }), 'local (本机)')
  assert.equal(nodeOptionLabel({ id: 'gpu-box', kind: 'byom', online: true }), 'gpu-box')
  assert.equal(nodeOptionLabel({ id: 'gpu-box', kind: 'byom', online: false }), 'gpu-box (离线)')
})

test('NodesModal：打开即拉取节点列表、签发后展示一次性令牌与命令、双栏布局', { timeout: 60_000 }, () => {
  // 打开时自动刷新。
  assert.match(nodesModalSource, /void refreshNodes\(\)/)
  // 双栏 asset-modal-body 布局 + maxWidth 880。
  assert.match(nodesModalSource, /asset-modal-body/)
  assert.match(nodesModalSource, /maxWidth:\s*880/)
  // 一次性令牌提示与复制。
  assert.match(nodesModalSource, /明文接入令牌仅展示一次（服务端仅存 SHA-256 摘要）/)
  assert.match(nodesModalSource, /CopyButton/)
  // 轮换与移除（内联二次确认）。
  assert.match(nodesModalSource, /轮换令牌/)
  assert.match(nodesModalSource, /确认移除/)
  // 在此节点新建对话。
  assert.match(nodesModalSource, /在此节点新建对话/)
  // 离线提示模板。
  assert.match(nodesModalSource, /该节点当前未连接/)
  // 前台 connect 标注为调试用途（前台常驻，非接入主路径）。
  assert.match(nodesModalSource, /前台连接（调试用）/)
  assert.match(nodesModalSource, /前台常驻，Ctrl\/Cmd\+C 退出/)
  // 组件文件只导出 NodesModal 组件（纯函数在 nodes-modal-model.ts）。
  const exports = [...nodesModalSource.matchAll(/export (?:function|const) ([A-Z]\w*)/g)].map((m) => m[1])
  assert.deepEqual(exports, ['NodesModal'])
})

test('签发/轮换交互约束：防重复提交、拒绝重复签发既有节点、签发后立即选中展示令牌', { timeout: 60_000 }, () => {
  // issue() 入口 guard：签发中直接返回，输入与按钮禁用、Enter 不重复触发。
  assert.match(nodesModalSource, /const issue = async \(\) => \{\s*if \(issuing\) return/)
  assert.match(nodesModalSource, /disabled=\{issuing\}/)
  assert.match(nodesModalSource, /if \(e\.key === 'Enter' && !issuing\) void issue\(\)/)
  // 新建面板拦截已存在节点 ID：提示改走「轮换令牌」，避免误轮换。
  assert.match(nodesModalSource, /existingNodeIds\.has\(validated\.nodeId\)/)
  assert.match(nodesModalSource, /重新签发会使旧令牌立即失效；请在左侧列表选中该节点后使用「轮换令牌」/)
  // 轮换：先 onTokenIssued 呈现一次性令牌，再 refreshNodes（刷新失败也不丢令牌）。
  const issuedAt = nodesModalSource.indexOf('onTokenIssued(issued.token)')
  const refreshAt = nodesModalSource.indexOf('await store.refreshNodes()')
  assert.ok(issuedAt !== -1 && refreshAt !== -1 && issuedAt < refreshAt, 'onTokenIssued 必须先于 refreshNodes')
  // 刚签发节点未进 store 列表时用占位详情先行选中（仅 id/kind/离线，不伪造在线/健康）。
  assert.match(nodesModalSource, /const issuedButUnlisted =/)
  assert.match(nodesModalSource, /\? \{ id: selectedId!, kind: 'byom', online: false \}/)
  // 签发后立即选中该节点并退出新建模式（不等列表读回）。
  assert.match(nodesModalSource, /setIssuedTokens\(\(prev\) => \(\{ \.\.\.prev, \[nodeId\]: token \}\)\)\s*setSelectedId\(nodeId\)/)
})

test('远端节点新建会话：必填目标机绝对路径 cwd，本机保持无 cwd', { timeout: 60_000 }, () => {
  // 远端（byom）节点强制 cwd：空时禁用创建，提交 trim 后的 cwd。
  assert.match(nodesModalSource, /const needsCwd = node\.kind === 'byom'/)
  assert.match(nodesModalSource, /const cwdValid = !needsCwd \|\| newConversationCwd\.trim\(\) !== ''/)
  assert.match(nodesModalSource, /aria-label="新对话工作目录，目标节点绝对路径"/)
  assert.match(nodesModalSource, /disabled=\{!cwdValid \|\| creating\}/)
  // 提交载荷：远端携 cwd（trim），本机不发 cwd 键（保持 Hub 缺省目录，不用 Hub cwd 冒充远端路径）。
  assert.match(nodesModalSource, /\.\.\.\(needsCwd \? \{ cwd: newConversationCwd\.trim\(\) \} : \{\}\)/)
  // createConversation 入口 guard：空 cwd 拒绝发起。
  assert.match(nodesModalSource, /if \(creating \|\| !cwdValid\) return/)
  // 头部快捷「在此节点新建对话」仅本机节点展示（远端走带 cwd 输入的专属卡片）。
  assert.match(nodesModalSource, /\{node\.kind === 'local' && \(/)
})

test('入口接线：App 挂载 / Sidebar 页脚与新建下拉 / 命令面板 / 会话顶栏节点选择器', { timeout: 60_000 }, () => {
  // App 挂载 NodesModal。
  assert.match(appSource, /store\.activeModal\?\.kind === 'nodes' && \(\s*<NodesModal initialNodeId=\{store\.activeModal\.nodeId\} onClose=\{closeModal\} \/>\s*\)/)
  // Sidebar 页脚「计算节点 Nodes」按钮。
  assert.match(sidebarSource, /计算节点 Nodes/)
  assert.match(sidebarSource, /store\.setActiveModal\(\{ kind: 'nodes' \}\)/)
  // 新建对话下拉底部「管理计算节点」。
  assert.match(sidebarSource, /管理计算节点/)
  // 命令面板 builtin:open-nodes。
  assert.match(paletteSource, /builtin:open-nodes/)
  assert.match(paletteSource, /'打开计算节点管理'/)
  assert.match(paletteSource, /keywords:\s*\['node', 'nodes', 'byom', 'helm-node', '节点'\]/)
  // 会话顶栏节点选择器：patch nodeId。
  assert.match(paneSource, /会话执行节点/)
  assert.match(paneSource, /conversationsApi\.patch\(conversationId, \{ nodeId:/)
  // Profile 编辑器节点输入关联已知节点 datalist。
  assert.match(profileEditorSource, /helm-known-nodes/)
})

test('Store：refreshNodes 更新 live.nodes 且异常时通知', { timeout: 60_000 }, () => {
  assert.match(storeProviderSource, /nodesApi\.list\(\)/)
  assert.match(storeProviderSource, /nodes:\s*sorted/)
  assert.match(storeProviderSource, /计算节点加载失败/)
})
