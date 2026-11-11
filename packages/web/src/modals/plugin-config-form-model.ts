/**
 * 插件配置表单纯数据模型（PluginDetailDrawer / PluginCenter 消费）。
 *
 * secret 字段的服务端契约：GET config 只回 '******' 掩码（已配置）或空串
 * （未配置），明文绝不出站。因此表单侧必须遵守两条铁律：
 * 1. 掩码绝不能当真值灌入表单——否则一次未改动的保存就会把六颗星
 *    写进 credentials.json，覆盖真实密钥；
 * 2. 保存时 secret 空串表示「未改动，保持已存密钥」，只有用户输入了
 *    新值才提交该字段。
 */

import type { PluginConfigFieldSchema, PluginConfigFieldSource } from '@helm/protocol'

export type ConfigValue = string | number | boolean

/** 表单初始值：secret 一律空串；非 secret 回显服务端值或缺省 default。 */
export function configFieldInitialValue(
  schemaField: Pick<PluginConfigFieldSchema, 'default' | 'type' | 'secret'>,
  raw: unknown,
): ConfigValue {
  if (schemaField.secret === true) return ''
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
    return String(raw)
  }
  if (schemaField.default !== undefined) return schemaField.default
  return schemaField.type === 'boolean' ? false : schemaField.type === 'number' ? 0 : ''
}

/** 服务端掩码（'******'）：GET config 对已配置 secret 的固定回显。 */
export const SECRET_MASK = '******'
export function secretConfigured(raw: unknown): boolean {
  return typeof raw === 'string' && raw.length > 0
}

/**
 * 保存载荷：非 secret 字段全量提交（维持既有合并语义）；secret 字段仅在
 * 用户输入了非空新值时提交。掩码与空串都绝不入载荷。
 */
export function buildPluginConfigPayload(
  schema: Record<string, PluginConfigFieldSchema>,
  values: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const payload: Record<string, ConfigValue> = {}
  for (const [key, field] of Object.entries(schema)) {
    const value = values[key]
    if (field.secret === true) {
      // 掩码与空白都视为「未改动」：即使异常路径把掩码灌进表单也绝不能写进凭据库。
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed.length > 0 && trimmed !== SECRET_MASK) payload[key] = trimmed
      continue
    }
    if (value !== undefined) payload[key] = value
  }
  return payload
}

/**
 * 单字段可否重置：
 * - source === 'configured'：磁盘存在用户显式覆写键，发送 null 可清除；
 * - 未提供 sources（旧内核）时，对已配置的 secret 字段（回显掩码非空串）
 *   同样允许清除，避免凭据无法收回。
 */
export function canResetConfigField(
  fieldSchema: PluginConfigFieldSchema,
  source?: PluginConfigFieldSource,
  rawValue?: unknown,
): boolean {
  if (source === 'configured') return true
  if (source !== undefined) return false
  return fieldSchema.secret === true && secretConfigured(rawValue)
}

/** 单字段重置载荷：发送 { [key]: null } 清除显式覆写值，回退 schema.default。 */
export function buildResetFieldPayload(key: string): Record<string, null> {
  return { [key]: null }
}
