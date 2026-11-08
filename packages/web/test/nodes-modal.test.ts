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

test('接入命令生成：connect / start / 一键 / 服务安装 / 诊断', { timeout: 60_000 }, () => {
  const guide = buildNodeConnectGuide('http://192.168.1.10:3202', {
    nodeId: 'gpu-box',
    token: 'gpu-box:secret123',
  })
  assert.equal(guide.connectCommand, 'helm-node connect http://192.168.1.10:3202 --token gpu-box:secret123')
  assert.equal(guide.startDaemonCommand, 'helm-node start -d')
  assert.equal(
    guide.oneLineCommand,
    'helm-node connect http://192.168.1.10:3202 --token gpu-box:secret123 && helm-node start -d',
  )
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
  // 组件文件只导出 NodesModal 组件（纯函数在 nodes-modal-model.ts）。
  const exports = [...nodesModalSource.matchAll(/export (?:function|const) ([A-Z]\w*)/g)].map((m) => m[1])
  assert.deepEqual(exports, ['NodesModal'])
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
