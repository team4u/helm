/**
 * 插件包管理纯函数模型
 *
 * 覆盖安装来源（npm / git / 本地路径）的本地识别与展示推导、
 * doctor 结构化检查结果的展示条目化、HTTP 错误诊断文案。
 * 仅做前端输入引导；最终解析与校验由 Hub 安装器裁决。
 */
import type { PluginDoctorReport, PluginPackageSource } from '@helm/protocol'

/** 安装来源的本地识别结果（仅用于输入引导与安全提示，不预判服务端行为）。 */
export type PluginSourceKindHint = 'npm' | 'git' | 'local' | 'unknown'

export interface PluginSourceHint {
  kind: PluginSourceKindHint
  /** 来源的人类可读标签（如「npm 包」「Git 仓库」）。 */
  label: string
}

/** 识别 `npm:<spec>` 前缀。 */
export function isNpmSource(input: string): boolean {
  return /^npm:[^\s]/.test(input.trim())
}

/** 识别 `git:<repo>@<ref>` 或 HTTPS Git URL（`https://…[.git][#<ref>]`）。 */
export function isGitSource(input: string): boolean {
  const value = input.trim()
  if (/^git:[^\s]+@[^\s]+$/.test(value)) return true
  return /^https:\/\/[^\s]+(\.git(?:#[^\s#]+)?|#\S+)?$/.test(value) && /\.git|^https:\/\/\S+#\S+$/.test(value)
}

/** 识别本地路径：绝对路径（POSIX / Windows UNC）或显式 `./`、`../` 相对路径。 */
export function isLocalSource(input: string): boolean {
  const value = input.trim()
  if (value.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return value.startsWith('./') || value.startsWith('../')
}

/**
 * 本地识别安装来源类别：仅用于输入框旁的即时来源提示，
 * 不替代服务端解析（非法输入最终由安装器返回结构化错误）。
 */
export function detectPluginSourceKind(input: string): PluginSourceHint {
  const value = input.trim()
  if (value === '') return { kind: 'unknown', label: '' }
  if (isNpmSource(value)) return { kind: 'npm', label: 'npm 包' }
  if (isGitSource(value)) return { kind: 'git', label: 'Git 仓库' }
  if (isLocalSource(value)) return { kind: 'local', label: '本地路径' }
  return { kind: 'unknown', label: '无法识别' }
}

/** 来源是否可作为安装请求提交（unknown 时不允许提交，避免盲发）。 */
export function isInstallSourceSubmittable(input: string): boolean {
  const { kind } = detectPluginSourceKind(input)
  return kind === 'npm' || kind === 'git' || kind === 'local'
}

/** 推导受管来源徽章的短标签（npm / git / 本地）。 */
export function pluginSourceBadgeLabel(source: PluginPackageSource): string {
  if (source.kind === 'npm') return 'npm'
  if (source.kind === 'git') return 'git'
  return '本地'
}

/** 推导受管来源的完整展示文本（如 `npm:helm-plugin-foo@^1.2.0`、`https://…#dev`）。 */
export function pluginSourceDisplayText(source: PluginPackageSource): string {
  return source.raw
}

/** 格式化安装时间为可读本地时间串；非法值回退空串。 */
export function formatInstalledAt(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

/** doctor 单项检查的展示条目。 */
export interface PluginDoctorCheckItem {
  id: string
  label: string
  ok: boolean
  /** 失败时的诊断文本（`code: message`）。 */
  errorText: string
}

/** 将结构化 doctor 报告转为逐项展示条目（保持服务端执行顺序）。 */
export function buildDoctorCheckItems(report: PluginDoctorReport): PluginDoctorCheckItem[] {
  return (report.checks ?? []).map((check) => ({
    id: check.id,
    label: check.label,
    ok: check.error === undefined,
    errorText:
      check.error === undefined ? '' : `${check.error.code}: ${check.error.message}`,
  }))
}

/** 从 doctor 报告中提取整体结论文案（存在失败项时逐项列出）。 */
export function buildDoctorConclusion(report: PluginDoctorReport): string {
  const failed = (report.checks ?? []).filter((check) => check.error !== undefined)
  if (report.ok && failed.length === 0) return '安装前自检通过'
  const parts = failed.map(
    (check) => `${check.id}（${check.error?.code ?? 'unknown'}）：${check.error?.message ?? ''}`,
  )
  return `安装前自检未通过，共 ${failed.length} 项失败：${parts.join('；')}`
}

/** 提取插件包操作（安装/更新/移除）失败时的诊断文案；409 在途任务给出明确指引。 */
export function pluginPackageErrorText(err: unknown, action: string): string {
  if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 409) {
    const code = (err as { code?: string }).code ?? 'plugin_has_live_tasks'
    return `${action}失败：插件存在在途任务（${code}）。请等待任务结束或中止后再试。`
  }
  return err instanceof Error ? `${action}失败：${err.message}` : `${action}失败`
}
