/**
 * 插件包管理纯函数模型
 *
 * 覆盖安装来源（npm / git / 本地路径）的本地识别与展示推导、
 * doctor 结构化检查结果的展示条目化、HTTP 错误诊断文案。
 * 仅做前端输入引导；最终解析与校验由 Hub 安装器裁决。
 */
import type { HelmLocale, PluginDoctorReport, PluginPackageSource } from '@helm/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

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

/** 识别 `git:<repo>[@<ref>]` 或 HTTPS Git URL（可省略 `.git` 和 ref）。 */
export function isGitSource(input: string): boolean {
  const value = input.trim()
  return /^git:[^\s]+$/.test(value) || /^https:\/\/[^\s]+$/.test(value)
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
export function detectPluginSourceKind(
  input: string,
  t: WebMessageTranslator = englishWebTranslator,
): PluginSourceHint {
  const value = input.trim()
  if (value === '') return { kind: 'unknown', label: '' }
  if (isNpmSource(value)) return { kind: 'npm', label: t('plugins.package.sourceKind.npm') }
  if (isGitSource(value)) return { kind: 'git', label: t('plugins.package.sourceKind.git') }
  if (isLocalSource(value)) return { kind: 'local', label: t('plugins.package.sourceKind.local') }
  return { kind: 'unknown', label: t('plugins.package.sourceKind.unknown') }
}

/** 来源是否可作为安装请求提交（unknown 时不允许提交，避免盲发）。 */
export function isInstallSourceSubmittable(input: string): boolean {
  const { kind } = detectPluginSourceKind(input)
  return kind === 'npm' || kind === 'git' || kind === 'local'
}

/** 推导受管来源徽章的短标签（npm / git / 本地）。 */
export function pluginSourceBadgeLabel(
  source: PluginPackageSource,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  if (source.kind === 'npm') return 'npm'
  if (source.kind === 'git') return 'git'
  return t('plugins.package.sourceBadge.local')
}

/** 推导受管来源的完整展示文本（如 `npm:helm-plugin-foo@^1.2.0`、`https://…#dev`）。 */
export function pluginSourceDisplayText(source: PluginPackageSource): string {
  return source.raw
}

/** 格式化安装时间为可读本地时间串；非法值回退空串。 */
export function formatInstalledAt(ms: number, locale?: HelmLocale): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  try {
    return locale !== undefined ? new Date(ms).toLocaleString(locale) : new Date(ms).toLocaleString()
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
export function buildDoctorConclusion(
  report: PluginDoctorReport,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  const failed = (report.checks ?? []).filter((check) => check.error !== undefined)
  if (report.ok && failed.length === 0) return t('plugins.package.doctorPassed')
  const parts = failed.map((check) =>
    t('plugins.package.doctorFailedItem', {
      id: check.id,
      code: check.error?.code ?? 'unknown',
      message: check.error?.message ?? '',
    }),
  )
  return t('plugins.package.doctorFailed', {
    count: failed.length,
    details: parts.join(t('plugins.package.doctorSeparator')),
  })
}

/** 提取插件包操作（安装/更新/移除）失败时的诊断文案；409 在途任务给出明确指引。 */
export function pluginPackageErrorText(
  err: unknown,
  action: string,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 409) {
    const code = (err as { code?: string }).code ?? 'plugin_has_live_tasks'
    return t('plugins.package.errorLiveTasks', { action, code })
  }
  return err instanceof Error
    ? t('plugins.package.errorWithMessage', { action, message: err.message })
    : t('plugins.package.errorGeneric', { action })
}

/**
 * 从安装失败错误中提取 doctor 报告并做形状校验，无有效报告时返回 null（绝不编造）。
 *
 * 真实 Hub 安装预检失败（422 plugin_package_doctor_failed）把完整报告放在
 * HelmError.details.report，经 HTTP 错误信封到达 ApiClientError.details.report；
 * 除此之外的挂载位置一概不认。
 */
export function extractDoctorReport(err: unknown): PluginDoctorReport | null {
  if (err === null || typeof err !== 'object') return null
  const details = (err as { details?: unknown }).details
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null
  const candidate = (details as Record<string, unknown>).report
  return isDoctorReportShape(candidate) ? candidate : null
}

/** 形状校验：dir 非空字符串、ok 布尔、checks 为逐项形状合法的数组；不满足即拒绝。 */
function isDoctorReportShape(value: unknown): value is PluginDoctorReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  if (typeof report.dir !== 'string' || report.dir === '') return false
  if (typeof report.ok !== 'boolean') return false
  if (!Array.isArray(report.checks)) return false
  return report.checks.every((check) => {
    if (check === null || typeof check !== 'object' || Array.isArray(check)) return false
    const c = check as Record<string, unknown>
    if (typeof c.id !== 'string' || typeof c.label !== 'string') return false
    if (c.error === undefined) return true
    if (c.error === null || typeof c.error !== 'object') return false
    const err = c.error as Record<string, unknown>
    return typeof err.code === 'string' && typeof err.message === 'string'
  })
}
