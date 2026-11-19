/**
 * Pure data model for the plugin config form (consumed by PluginDetailDrawer
 * / PluginCenter).
 *
 * Server contract for secret fields: GET config only returns the '******'
 * mask (configured) or an empty string (unconfigured); plaintext never leaves
 * the server. The form side therefore obeys two hard rules:
 * 1. The mask must never be poured into the form as a real value — one
 *    unchanged save would write six asterisks into credentials.json,
 *    overwriting the real key;
 * 2. On save, an empty secret string means "unchanged, keep the stored key";
 *    the field is only submitted when the user types a new value.
 */

import type { PluginConfigFieldSchema, PluginConfigFieldSource } from '@helmx/protocol/browser'

export type ConfigValue = string | number | boolean

/** Initial form values: secrets always empty; non-secrets echo the server value or the schema default. */
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

/** Server-side mask ('******'): the fixed GET config echo for a configured secret. */
export const SECRET_MASK = '******'
export function secretConfigured(raw: unknown): boolean {
  return typeof raw === 'string' && raw.length > 0
}

/**
 * Save payload: non-secret fields are submitted in full (existing merge
 * semantics preserved); secret fields are submitted only when the user typed
 * a non-empty new value. Masks and empty strings never enter the payload.
 */
export function buildPluginConfigPayload(
  schema: Record<string, PluginConfigFieldSchema>,
  values: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const payload: Record<string, ConfigValue> = {}
  for (const [key, field] of Object.entries(schema)) {
    const value = values[key]
    if (field.secret === true) {
      // Mask and blank both count as "unchanged": even if an abnormal path
      // poured the mask into the form, it must never reach the credential store.
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed.length > 0 && trimmed !== SECRET_MASK) payload[key] = trimmed
      continue
    }
    if (value !== undefined) payload[key] = value
  }
  return payload
}

/**
 * Whether a single field can be reset:
 * - source === 'configured': an explicit user override key exists on disk;
 *   sending null clears it;
 * - without sources (older kernels), a configured secret field (mask echo
 *   non-empty) is also resettable so credentials can be revoked.
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

/** Reset payload for a single field: send { [key]: null } to clear the explicit override and fall back to schema.default. */
export function buildResetFieldPayload(key: string): Record<string, null> {
  return { [key]: null }
}
