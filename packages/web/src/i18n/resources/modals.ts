/**
 * Modal-support model copy (node picker option labels, node enrollment ID
 * validation, node upgrade gating hints, node usage label; provider auth and
 * profile editor skills models carry no display copy). Owner: the
 * profiles-skills partition.
 *
 * These models are consumed by modules owned by other partitions; their pure
 * functions take an optional `t` and default to the English bridge translator
 * so unmigrated call sites keep rendering English exactly as before.
 */
import type { MessageTable } from '../messages.js'

export const modalsMessages = {
  // Node enrollment ID validation (form display copy).
  'modals.nodeId.empty': { en: 'Enter a node ID', 'zh-CN': '请输入节点 ID' },
  'modals.nodeId.localReserved': {
    en: 'local is the built-in local node; no access token needed',
    'zh-CN': 'local 是内建本机节点，无需签发接入令牌',
  },
  'modals.nodeId.invalidChars': {
    en: 'Node ID must start with a letter or digit and contain only letters, digits and . _ - (max 128 characters)',
    'zh-CN': '节点 ID 需以字母或数字开头，仅含字母、数字、. _ -，最长 128 字符',
  },

  // Node option labels for conversation/profile node pickers.
  'modals.nodeOption.local': { en: '{id} (local)', 'zh-CN': '{id} (本机)' },
  'modals.nodeOption.offline': { en: '{id} (offline)', 'zh-CN': '{id} (离线)' },

  // Node upgrade confirm gating hints.
  'modals.nodeUpgrade.offline': { en: 'Node is offline; cannot upgrade', 'zh-CN': '节点已离线，无法升级' },
  'modals.nodeUpgrade.invalidTarget': {
    en: 'Target version is not valid SemVer (e.g. 0.2.0)',
    'zh-CN': '目标版本不是合法 SemVer（示例 0.2.0）',
  },
  'modals.nodeUpgrade.checkFirst': {
    en: 'Check for updates first, or enter an explicit target version',
    'zh-CN': '请先检查更新，或填写明确的目标版本',
  },
  'modals.nodeUpgrade.upToDate': {
    en: 'Already up to date; tick force reinstall/retry or enter a target version',
    'zh-CN': '当前已是最新版本；可勾选强制重装/重试，或填写目标版本',
  },

  // Node resource usage summary label.
  'modals.nodeUsage.label': { en: '{used} / {total} ({percent}%)', 'zh-CN': '{used} / {total}（{percent}%）' },
} satisfies MessageTable
