/**
 * Node center display copy (NodeCenter / NodeCard / NodeDetailDrawer plus the
 * node-center-model pure helpers). Owner: the models-nodes partition. Chinese
 * copy is backfilled verbatim from the en/zh translation baseline (b4a611a65);
 * interpolation uses `{param}`. SDK component defaults (CopyButton) are
 * localized by the host locale port and never duplicated here.
 */
import type { MessageTable } from '../messages.js'

export const nodesMessages = {
  // Center chrome
  'nodes.title': { en: 'Compute Nodes Center', 'zh-CN': '计算节点中心' },
  'nodes.connect': { en: 'Connect node', 'zh-CN': '接入节点' },
  'nodes.connectTitle': {
    en: 'Connect new distributed compute nodes',
    'zh-CN': '接入新的分布式计算节点',
  },
  'nodes.searchPlaceholder': {
    en: 'Search node ID, name, platform, version or OS…',
    'zh-CN': '搜索节点 ID、名称、平台架构、版本或操作系统…',
  },
  'nodes.searchAria': { en: 'Search compute nodes', 'zh-CN': '搜索计算节点' },
  'nodes.searchClear': { en: 'Clear search', 'zh-CN': '清空搜索' },
  'nodes.filterAria': { en: 'Filter by compute node category', 'zh-CN': '计算节点分类筛选' },
  'nodes.local': { en: 'Local', 'zh-CN': '本机' },
  'nodes.remote': { en: 'Remote', 'zh-CN': '远端' },
  'nodes.emptyTitle': { en: 'No matching compute nodes', 'zh-CN': '未找到匹配的计算节点' },
  'nodes.emptyHint': {
    en: 'Try adjusting the search keywords or switching category tabs.',
    'zh-CN': '请尝试调整搜索关键字或切换分类标签。',
  },
  'nodes.resetFilters': { en: 'Reset filters', 'zh-CN': '重置筛选条件' },

  // Node card
  'nodes.statusOnlineTitle': { en: 'Node online and running', 'zh-CN': '节点在线运行中' },
  'nodes.statusOfflineTitle': { en: 'Node offline', 'zh-CN': '节点离线' },
  'nodes.localTitle': { en: 'Microkernel local node', 'zh-CN': '微内核本机节点' },
  'nodes.versionTitle': { en: 'Version {version}', 'zh-CN': '版本 {version}' },
  'nodes.platformTitle': { en: 'Platform and architecture', 'zh-CN': '平台与架构' },
  'nodes.hostnameTitle': { en: 'Hostname: {hostname}', 'zh-CN': '主机名: {hostname}' },
  'nodes.uptimeTitle': { en: 'Uptime: {uptime}', 'zh-CN': '运行时长: {uptime}' },
  'nodes.cardToolTitle': { en: 'Tool: {tool}', 'zh-CN': '工具能力: {tool}' },
  'nodes.moreTools': { en: '{count} more tools', 'zh-CN': '另有 {count} 项工具能力' },

  // Display-name fallbacks (getNodeDisplayName)
  'nodes.displayName.localKernel': { en: 'Local kernel', 'zh-CN': '本机内核' },
  'nodes.displayName.unknown': { en: 'Unknown node', 'zh-CN': '未知节点' },

  // Detail drawer chrome
  'nodes.drawer.newTitle': { en: 'Connect a new compute node', 'zh-CN': '接入新计算节点' },
  'nodes.drawer.titleFallback': { en: 'Node details', 'zh-CN': '节点详情' },
  'nodes.drawer.invalidNodeId': { en: 'Enter a valid node ID', 'zh-CN': '请指定有效的节点 ID' },
  'nodes.drawer.noSelection': { en: 'No node selected', 'zh-CN': '未选择节点' },

  // System overview section
  'nodes.drawer.overview': { en: 'System overview', 'zh-CN': '系统概览' },
  'nodes.drawer.os': { en: 'Operating system', 'zh-CN': '操作系统' },
  'nodes.drawer.arch': { en: 'CPU architecture', 'zh-CN': 'CPU 架构' },
  'nodes.drawer.version': { en: 'Node version', 'zh-CN': 'Node 版本' },
  'nodes.drawer.hostname': { en: 'Hostname', 'zh-CN': '主机名' },
  'nodes.drawer.cwd': { en: 'Working directory', 'zh-CN': '工作目录' },
  'nodes.drawer.channel': { en: 'Connection channel', 'zh-CN': '连接通道' },
  'nodes.drawer.localIpc': { en: 'Local IPC / socket', 'zh-CN': '本地 IPC / Socket' },
  'nodes.drawer.uptime': { en: 'Uptime', 'zh-CN': '运行时长' },

  // Health check section
  'nodes.drawer.healthSection': {
    en: 'Health check and resource load',
    'zh-CN': '健康体检与资源负载',
  },
  'nodes.drawer.checking': { en: 'Checking…', 'zh-CN': '体检中…' },
  'nodes.drawer.healthAction': { en: 'Health check', 'zh-CN': '健康体检' },
  'nodes.drawer.cpuUsage': { en: 'CPU usage', 'zh-CN': 'CPU 占用' },
  'nodes.drawer.systemLoad': { en: 'System load', 'zh-CN': '系统负载' },
  'nodes.drawer.memUsage': { en: 'Memory usage', 'zh-CN': '内存使用' },
  'nodes.drawer.diskSpace': { en: 'Disk space', 'zh-CN': '磁盘空间' },
  'nodes.drawer.updateAvailable': {
    en: 'Update available: v{version}',
    'zh-CN': '存在可用更新：v{version}',
  },
  'nodes.drawer.upToDate': {
    en: 'Node kernel healthy and up to date',
    'zh-CN': '节点内核运行正常，版本已处于最新状态',
  },

  // Remote enrollment section
  'nodes.drawer.enrollSection': {
    en: 'Controlled machine enrollment command',
    'zh-CN': '受控机接入指令',
  },
  'nodes.drawer.nodeId': { en: 'Node ID', 'zh-CN': '节点 ID' },
  'nodes.drawer.nodeIdPlaceholder': { en: 'e.g. gpu-worker-1', 'zh-CN': '例如 gpu-worker-1' },
  'nodes.drawer.issueToken': { en: 'Issue access token', 'zh-CN': '签发接入令牌' },
  'nodes.drawer.reissueToken': { en: 'Re-issue token', 'zh-CN': '重新签发令牌' },
  'nodes.drawer.tokenLabel': {
    en: 'Access token (shown once):',
    'zh-CN': '接入令牌（一次性展示）：',
  },
  'nodes.drawer.copyToken': { en: 'Copy token', 'zh-CN': '复制令牌' },
  'nodes.drawer.copied': { en: 'Copied', 'zh-CN': '已复制' },
  'nodes.drawer.oneLineLabel': {
    en: 'One-line enrollment command (background daemon start):',
    'zh-CN': '一键接入命令行（后台守护进程启动）：',
  },
  'nodes.drawer.copyCommandTitle': { en: 'Copy command line', 'zh-CN': '复制命令行' },
  'nodes.drawer.copyCommand': { en: 'Copy command', 'zh-CN': '复制命令' },
  'nodes.drawer.maintenanceLabel': {
    en: 'Common maintenance commands:',
    'zh-CN': '常用维护命令：',
  },

  // Registered tools section
  'nodes.drawer.toolsSection': { en: 'Registered tools', 'zh-CN': '注册工具能力' },
  'nodes.drawer.toolTitle': { en: 'Tool: {tool}', 'zh-CN': '工具: {tool}' },
} satisfies MessageTable
