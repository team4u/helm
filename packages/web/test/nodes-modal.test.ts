import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildNodeConnectGuide,
  canConfirmNodeUpgrade,
  compareNodeSemver,
  formatBytes,
  formatNodeVersion,
  formatUptime,
  formatUsage,
  isNodeBehindHub,
  nodeOptionLabel,
  parseNodeSemver,
  resolveUpgradeTarget,
  NODE_ID_PATTERN,
  validateNodeIdInput,
} from '../src/modals/nodes-modal-model.js'

const nodesModalSource = readFileSync(new URL('../src/modals/NodesModal.tsx', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
const paletteSource = readFileSync(new URL('../src/modals/CommandPaletteModal.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
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
  assert.match(nodesModalSource, /前台常驻，按 Ctrl\+C 退出/)
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

test('入口接线：App 挂载 / Sidebar 页脚与智能体站位 / 命令面板 / 会话顶栏节点选择器', { timeout: 60_000 }, () => {
  // App 挂载 NodesModal。
  assert.match(appSource, /store\.activeModal\?\.kind === 'nodes' && \(\s*<NodesModal initialNodeId=\{store\.activeModal\.nodeId\} onClose=\{closeModal\} \/>\s*\)/)
  // Sidebar 页脚「计算节点 Nodes」按钮。
  assert.match(sidebarSource, /计算节点 Nodes/)
  assert.match(sidebarSource, /store\.setActiveModal\(\{ kind: 'nodes' \}\)/)
  // 节点管理仍由页脚提供，智能体入口负责按角色新建对话。
  assert.match(sidebarSource, /AgentStandingsGroup/)
  // 命令面板 builtin:open-nodes。
  assert.match(paletteSource, /builtin:open-nodes/)
  assert.match(paletteSource, /'打开计算节点管理'/)
  assert.match(paletteSource, /keywords:\s*\['node', 'nodes', 'byom', 'helm-node', '节点'\]/)
  // 会话起始环境节点选择器（仅空会话展示，随 Composer 起始环境配置条）：patch nodeId。
  assert.match(composerSource, /会话执行节点/)
  assert.match(composerSource, /conversationsApi\.patch\(conversation\.id, \{ nodeId:/)
  // 会话顶栏不再常驻节点下拉与 profile 徽章，改只读副标题（formatEnvSubtitle）。
  assert.match(paneSource, /formatEnvSubtitle/)
  assert.doesNotMatch(paneSource, /aria-label="会话执行节点"/)
  // Profile 编辑器节点输入关联已知节点 datalist。
  assert.match(profileEditorSource, /helm-known-nodes/)
})

test('Store：refreshNodes 更新 live.nodes 且异常时通知', { timeout: 60_000 }, () => {
  assert.match(storeProviderSource, /nodesApi\.list\(\)/)
  assert.match(storeProviderSource, /nodes:\s*sorted/)
  assert.match(storeProviderSource, /计算节点加载失败/)
})

test('formatNodeVersion：空值返回 null、补 v 前缀、保留既有 v 前缀', { timeout: 60_000 }, () => {
  assert.equal(formatNodeVersion(undefined), null)
  assert.equal(formatNodeVersion(''), null)
  assert.equal(formatNodeVersion('   '), null)
  assert.equal(formatNodeVersion('0.1.0'), 'v0.1.0')
  assert.equal(formatNodeVersion('v0.1.0'), 'v0.1.0')
  assert.equal(formatNodeVersion(' 1.2.3 '), 'v1.2.3')
})

test('compareNodeSemver：严格 SemVer 比较（正式>预发布、预发布逐段、build metadata 忽略）', { timeout: 60_000 }, () => {
  // 基本核心段比较（数字而非字符串）。
  assert.equal(compareNodeSemver('0.1.0', '0.1.0'), 0)
  assert.equal(compareNodeSemver('v0.1.0', '0.1.0'), 0, 'v 前缀容忍')
  assert.equal(compareNodeSemver('0.2.0', '0.1.9'), 1)
  assert.equal(compareNodeSemver('0.1.9', '0.2.0'), -1)
  assert.equal(compareNodeSemver('1.10.0', '1.9.0'), 1, '数字比较而非字符串比较')
  // 正式版 > 预发布版：1.0.0-beta 不等于 1.0.0。
  assert.equal(compareNodeSemver('1.0.0', '1.0.0-beta'), 1)
  assert.equal(compareNodeSemver('1.0.0-beta', '1.0.0'), -1)
  // 预发布数字段按数值比较：beta.2 > beta.10 应为 false。
  assert.equal(compareNodeSemver('1.0.0-beta.2', '1.0.0-beta.10'), -1)
  assert.equal(compareNodeSemver('1.0.0-beta.10', '1.0.0-beta.2'), 1)
  // 预发布标识符文法：数字 < 字母数字；段多者大。
  assert.equal(compareNodeSemver('1.0.0-1', '1.0.0-alpha'), -1)
  assert.equal(compareNodeSemver('1.0.0-alpha', '1.0.0-beta'), -1)
  assert.equal(compareNodeSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareNodeSemver('1.0.0-alpha.1', '1.0.0-alpha'), 1)
  // build metadata 忽略不参与比较。
  assert.equal(compareNodeSemver('1.0.0+build.1', '1.0.0+build.2'), 0)
  // 非法 SemVer（两段、前导零、乱码）无法比较返回 0。
  assert.equal(compareNodeSemver('0.1', '0.1.0'), 0)
  assert.equal(compareNodeSemver('01.2.3', '1.2.3'), 0)
  assert.equal(compareNodeSemver('garbage', '1.0.0'), 0)
  assert.equal(parseNodeSemver('0.1'), null, '两段版本非法')
  assert.equal(parseNodeSemver('0.1.0') !== null, true)
  assert.equal(parseNodeSemver('1.0.0-beta.1') !== null, true)
  assert.equal(parseNodeSemver('1.0.0+meta') !== null, true)
  assert.equal(parseNodeSemver('01.0.0'), null, '数值段禁前导零')
  assert.equal(parseNodeSemver('  1.2.3  ') !== null, true, '容忍首尾空白')
})

test('isNodeBehindHub：非法 SemVer 返回 false，合法严格比较', { timeout: 60_000 }, () => {
  assert.equal(isNodeBehindHub('0.1.0', '0.2.0'), true, 'Hub 更高 -> 落后')
  assert.equal(isNodeBehindHub('v0.1.0', 'v0.2.0'), true)
  assert.equal(isNodeBehindHub('0.2.0', '0.1.0'), false, '节点更新 -> 不落后')
  assert.equal(isNodeBehindHub('0.1.0', '0.1.0'), false, '同版 -> 不落后')
  // 任一侧缺失/空白：无法判定，返回 false。
  assert.equal(isNodeBehindHub(undefined, '0.2.0'), false)
  assert.equal(isNodeBehindHub('0.1.0', undefined), false)
  assert.equal(isNodeBehindHub('  ', '0.2.0'), false)
  assert.equal(isNodeBehindHub('0.1.0', ''), false)
  // 任一侧非法 SemVer：不得用「截断到 1.0.0」等幅值判定，直接无法判定 false。
  assert.equal(isNodeBehindHub('garbage', '0.2.0'), false, '节点版本非法 -> 无法判定')
  assert.equal(isNodeBehindHub('0.1.0', 'not-a-version'), false, 'Hub 版本非法 -> 无法判定')
  assert.equal(isNodeBehindHub('0.1', '0.2.0'), false, '两段版本非法 -> 无法判定')
})

test('isNodeBehindHub 修正：1.0.0-beta 节点 vs 1.0.0 Hub 应为落后（正式 > 预发布）', { timeout: 60_000 }, () => {
  assert.equal(compareNodeSemver('1.0.0', '1.0.0-beta') > 0, true)
  assert.equal(isNodeBehindHub('1.0.0-beta', '1.0.0'), true, 'Hub 正式版高于节点预发布版 -> 落后')
})

test('canConfirmNodeUpgrade：离线/缺检查/已最新等门控分支', { timeout: 60_000 }, () => {
  const check = { currentVersion: '0.1.0', latestVersion: '0.2.0', updateAvailable: true }
  // 离线一律拒绝。
  assert.deepEqual(canConfirmNodeUpgrade({ online: false, check, targetVersion: '', force: false }), {
    ok: false,
    hint: '节点已离线，无法升级',
  })
  // 无检查且未填目标：拒绝（不允许盲升级 npm latest）。
  assert.deepEqual(canConfirmNodeUpgrade({ online: true, check: null, targetVersion: '', force: false }), {
    ok: false,
    hint: '请先检查更新，或填写明确的目标版本',
  })
  // 无检查但显式合法目标：允许。
  assert.deepEqual(canConfirmNodeUpgrade({ online: true, check: null, targetVersion: ' 0.2.0 ', force: false }), { ok: true, hint: null })
  // 无检查 + 非法目标：拒绝。
  assert.equal(canConfirmNodeUpgrade({ online: true, check: null, targetVersion: 'banana', force: false }).ok, false)
  // 检查发现有更新 + 无显式目标：允许（目标固定为 latestVersion）。
  assert.deepEqual(canConfirmNodeUpgrade({ online: true, check, targetVersion: '', force: false }), { ok: true, hint: null })
  // 检查发现已是最新 + 无目标无 force：拒绝。
  const upToDate = { currentVersion: '0.2.0', latestVersion: '0.2.0', updateAvailable: false }
  assert.equal(canConfirmNodeUpgrade({ online: true, check: upToDate, targetVersion: '', force: false }).ok, false)
  // 已最新 + force：允许（强制重装）。
  assert.equal(canConfirmNodeUpgrade({ online: true, check: upToDate, targetVersion: '', force: true }).ok, true)
  // 已最新 + 显式目标：允许。
  assert.equal(canConfirmNodeUpgrade({ online: true, check: upToDate, targetVersion: '0.3.0', force: false }).ok, true)
  // 非法目标始终拒绝。
  assert.equal(canConfirmNodeUpgrade({ online: true, check, targetVersion: '0.2', force: false }).ok, false)
})

test('resolveUpgradeTarget：显式输入优先，否则固定为本次检查 latestVersion', { timeout: 60_000 }, () => {
  const check = { currentVersion: '0.1.0', latestVersion: '0.2.0', updateAvailable: true }
  assert.equal(resolveUpgradeTarget(check, ''), '0.2.0', '无显式输入 -> 固定 latestVersion，不随点击时点漂移')
  assert.equal(resolveUpgradeTarget(check, '  0.3.0  '), '0.3.0', '显式输入优先（trim）')
  assert.equal(resolveUpgradeTarget(null, ''), null, '无检查无输入 -> null（禁止盲升级）')
  assert.equal(resolveUpgradeTarget(null, '0.3.0'), '0.3.0')
  const noLatest = { currentVersion: '0.1.0', latestVersion: '', updateAvailable: false }
  assert.equal(resolveUpgradeTarget(noLatest, ''), null)
})

test('nodesApi.checkUpgrade / nodesApi.upgrade：路由、参数序列化与请求载荷', { timeout: 60_000 }, () => {
  // 检查更新：GET /api/nodes/:id/upgrade/check，registryUrl 可选 query 参数。
  assert.match(apiSource, /checkUpgrade: \(nodeId: string, registryUrl\?: string\) =>/)
  assert.match(apiSource, /\/upgrade\/check\$\{qs\}/)
  assert.match(apiSource, /registryUrl=\$\{encodeURIComponent\(registryUrl\)\}/)
  // 升级：POST /api/nodes/:id/upgrade，载荷 NodeUpgradeInput。
  assert.match(apiSource, /upgrade: \(nodeId: string, input: NodeUpgradeInput = \{\}\) =>/)
  assert.match(apiSource, /'POST',\s*`\/api\/nodes\/\$\{encodeURIComponent\(nodeId\)\}\/upgrade`/)
  // 类型 re-export。
  assert.match(apiSource, /NodeBlockedRelease/)
  assert.match(apiSource, /NodeUpgradeCheckInput/)
  assert.match(apiSource, /NodeUpgradeCheckResult/)
  assert.match(apiSource, /NodeUpgradeInput/)
  assert.match(apiSource, /NodeUpgradeResult/)
})

test('版本徽章展示：左栏列表项、右栏摘要与「连接与环境」卡片', { timeout: 60_000 }, () => {
  // 左栏列表项徽章。
  assert.match(nodesModalSource, /\{formatNodeVersion\(node\.version\) !== null && \(\s*<span className="badge mono">\{formatNodeVersion\(node\.version\)\}<\/span>/)
  // 右栏顶部徽章区。
  assert.match(nodesModalSource, /\{formatNodeVersion\(node\.version\) !== null && \(\s*<span className="badge badge-neutral mono">\{formatNodeVersion\(node\.version\)\}<\/span>/)
  // 「连接与环境」卡片 version 行。
  assert.match(nodesModalSource, /<InfoRow label="version" value=\{formatNodeVersion\(node\.version\) \?\? '--'\} \/>/)
})

test('低于 Hub 版本提示：仅比较版本不断言可安装，徽章与对齐 Hub 目标按钮', { timeout: 60_000 }, () => {
  // hubVersion 从 local 节点提取并传给 NodeDetailPanel / NodeUpgradeCard。
  assert.match(nodesModalSource, /const hubVersion = nodes\.find\(\(n\) => n\.id === 'local'\)\?\.version/)
  assert.match(nodesModalSource, /hubVersion=\{hubVersion\}/)
  // 仅 byom 节点且 isNodeBehindHub 判定通过时展示徽章（左栏与右栏各一处）。
  const behindBadgeCount = [...nodesModalSource.matchAll(/node\.kind === 'byom' && isNodeBehindHub\(node\.version, hubVersion\)/g)].length
  assert.ok(behindBadgeCount >= 2, `左栏列表项与右栏顶部均需落后徽章，实际 ${behindBadgeCount} 处`)
  // 徽章文案只比较版本，不得断言「可升级至」（能否安装以 npm 检查为准）。
  assert.doesNotMatch(nodesModalSource, /可升级至/)
  assert.match(nodesModalSource, /低于 Hub \{formatNodeVersion\(hubVersion\)\}/)
  assert.match(nodesModalSource, /能否安装该版本以 npm 检查结果为准/)
  // 对齐 Hub 是显式目标按钮（写入目标输入），与检查 npm 最新是两个不同动作。
  assert.match(nodesModalSource, /目标对齐 Hub/)
  assert.match(nodesModalSource, /检查最新（npm）与对齐 Hub 是两个不同目标，Hub 开发版本未必已发布。/)
})

test('升级按钮：仅 byom 节点、离线禁用、展开面板并自动触发检查', { timeout: 60_000 }, () => {
  assert.match(nodesModalSource, /aria-label="检查更新与升级节点"/)
  assert.match(nodesModalSource, /disabled=\{!node\.online\}/)
  assert.match(nodesModalSource, /title=\{node\.online \? undefined : '节点已离线，无法升级'\}/)
  // 展开即触发首次检查（无既有结果且无错误时）。
  assert.match(nodesModalSource, /const openUpgrade = \(\) => \{\s*setUpgradeOpen\(true\)\s*if \(upgradeCheck === null && checkError === null\) void runUpgradeCheck\(\)/)
  // 面板展开条件：点击展开或已存在检查结果。
  assert.match(nodesModalSource, /\{node\.kind === 'byom' && \(upgradeOpen \|\| upgradeCheck !== null\) && \(/)
})

test('升级检查交互：检查中/失败不显示结论/npm 最新/回滚告警文案', { timeout: 60_000 }, () => {
  assert.match(nodesModalSource, /正在检查最新版本\.\.\./)
  assert.match(nodesModalSource, /重新检查/)
  assert.match(nodesModalSource, /发现新版本 v\{effectiveCheck\.latestVersion\}/)
  // npm 最新结论：不与 Hub 版本混清。
  assert.match(nodesModalSource, /npm 当前已是最新版本 \(v\{effectiveCheck\.currentVersion\}\)/)
  // 检查失败时旧 check 不作为结论依据（effectiveCheck 置 null）。
  assert.match(nodesModalSource, /const effectiveCheck = checkError === null \? check : null/)
  assert.match(nodesModalSource, /上次升级至 v\{check\.blocked\.version\} 失败回滚原因：\{check\.blocked\.reason\}（时间：\{check\.blocked\.at\}）/, '回滚记录在检查失败时仍展示（来自旧 check）')
  // 说明文案：不使用「金丝雀」实现术语，不作绝不失联承诺。
  assert.doesNotMatch(nodesModalSource, /金丝雀/)
  assert.match(nodesModalSource, /升级会先等待在途命令完成、校验安装包完整性并启动新进程，确认新进程已连接 Hub 后完成切换；若新版本启动异常将回退至当前版本。升级期间节点可能短暂离线。/)
  // 目标版本可选输入与 force 开关。
  assert.match(nodesModalSource, /aria-label="指定目标版本（可选）"/)
  assert.match(nodesModalSource, /留空则安装本次检查到的最新版本/)
  assert.match(nodesModalSource, /force/)
})

test('确认升级门控：离线禁用、缺检查/已最新拒绝、固定目标、res.ok 核验、成功后清旧检查', { timeout: 60_000 }, () => {
  // handler 早返回：离线 / 门控未过 / 无明确目标。
  assert.match(nodesModalSource, /if \(upgrading \|\| checking \|\| !node\.online\) return/)
  assert.match(nodesModalSource, /if \(!canConfirmNodeUpgrade\(\{ online: node\.online, check: checkError === null \? upgradeCheck : null, targetVersion, force \}\)\.ok\) return/)
  assert.match(nodesModalSource, /if \(resolved === null\) return/)
  // 载荷：目标固定为 resolveUpgradeTarget 结果（显式优先，否则本次检查 latestVersion），不盲发空目标。
  assert.match(nodesModalSource, /targetVersion: resolved/)
  assert.match(nodesModalSource, /\.\.\.\(force \? \{ force: true \} : \{\}\)/)
  // 按钮禁用：离线与门控均参与。
  assert.match(nodesModalSource, /disabled=\{checking \|\| upgrading \|\| !node\.online \|\| !confirmability\.ok\}/)
  assert.match(nodesModalSource, /title=\{!node\.online \? offlineTitle : confirmability\.ok \? undefined : \(confirmability\.hint \?\? undefined\)\}/)
  // 重新检查同样离线禁用。
  assert.match(nodesModalSource, /disabled=\{checking \|\| upgrading \|\| !node\.online\}/)
  // res.ok === false 不得显示成功：显式错误分支在前。
  assert.match(nodesModalSource, /if \(!res\.ok\) \{/, '必须核验 res.ok')
  assert.match(nodesModalSource, /升级节点未成功/)
  const notOkAt = nodesModalSource.indexOf('if (!res.ok) {')
  const upgradedAt = nodesModalSource.indexOf('if (res.upgraded)')
  assert.ok(notOkAt !== -1 && upgradedAt !== -1 && notOkAt < upgradedAt, '!res.ok 分支必须先于 res.upgraded 分支')
  // Hub 在新进程提交接管后才返回 upgraded，通知与该契约一致。
  assert.match(nodesModalSource, /\$\{node\.id\} 已从 v\$\{res\.previousVersion\} 升级至 v\$\{res\.targetVersion\}，新进程已连接 Hub 并确认接管/)
  assert.match(nodesModalSource, /\$\{node\.id\} 已在目标版本 v\$\{res\.targetVersion\}/)
  // 升级中禁用与进度文案。
  assert.match(nodesModalSource, /升级中\.\.\./)
  // 失败通知与卡片内错误文本。
  assert.match(nodesModalSource, /升级节点失败/)
  assert.match(nodesModalSource, /setUpgradeError\(message\)/)
  // 成功后清旧检查（不保留过期当前版本卡），刷新节点并重查。
  assert.match(nodesModalSource, /setUpgradeCheck\(null\)/)
  const clearAt = nodesModalSource.indexOf('setUpgradeCheck(null)', upgradedAt)
  const refreshAfterAt = nodesModalSource.indexOf('await store.refreshNodes()', clearAt)
  assert.ok(clearAt !== -1 && refreshAfterAt !== -1 && clearAt < refreshAfterAt, '成功后先清旧检查再刷新节点')
})
