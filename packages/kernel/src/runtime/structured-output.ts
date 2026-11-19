/**
 * Structured output for native subagents (extracted from spawn.ts).
 *
 * - register_structured_output tool: full AJV validation (reuses plugins/schema; rejects $async explicitly);
 *   tool-level rejection lets the model retry in the same turn; result slots are isolated per conversation via
 *   an injected sessions Map (owned per Harness by the host instead of a module-global WeakMap);
 * - Text fallback extraction: extractJsonCandidates / scanBalanced (scans all balanced {...}/[...] literals,
 *   including multiline): fenced json blocks first, then balanced scan, then whole-text parse.
 */

import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { HelmxError } from '@helmx/protocol'
import { validateOrThrow } from '../plugins/schema.js'

/** Extension name for native subagent structured output (shared by installation and fork stripping). */
export const STRUCTURED_OUTPUT_EXTENSION_NAME = 'helmx-structured-output'

/** Single-conversation structured output task slot: schema + accepted result (undefined = not yet accepted). */
export interface StructuredOutputSession {
  schema: Record<string, unknown>
  accepted: unknown | undefined
}

/**
 * Build the helmx-structured-output extension (reusable tool definition; re-registering the same name replaces in place).
 * Result slots are looked up in the injected sessions Map (per-runtime instance, isolated by conversationId).
 */
export function buildStructuredOutputExtension(sessions: Map<number, StructuredOutputSession>): Extension {
  const tool: ToolRegistration = defineTool({
    name: 'register_structured_output',
    description:
      'Submit the final structured result. output must satisfy the task JSON Schema; validation errors are returned so you can fix and retry.',
    parameters: {
      type: 'object',
      properties: {
        output: {
          description: 'Structured result satisfying the task JSON Schema (any JSON value, including null)',
        },
      },
      required: ['output'],
      // output value shape is fully validated by the task Schema; do not constrain its internal fields here.
      additionalProperties: false,
    },
    structuredOutputSchema: {
      type: 'object',
      properties: { accepted: { type: 'boolean' } },
      required: ['accepted'],
    },
    async execute(args, api) {
      const session = sessions.get(api.conversationId as number)
      if (session === undefined) {
        return { output: [{ type: 'text', text: 'No active structured output task in the current conversation.' }], isError: true }
      }
      const payload = (args as { output?: unknown }).output
      const result = validateStructuredOutputPayload(payload, session.schema)
      if (!result.ok) {
        return {
          output: [
            {
              type: 'text',
              text:
                `Structured output validation failed; fix the errors and call register_structured_output again:\n${result.errors}` +
                `\n\nSchema: ${JSON.stringify(session.schema)}`,
            },
          ],
          isError: true,
        }
      }
      session.accepted = result.value
      return {
        output: [{ type: 'text', text: 'Structured output accepted.' }],
        structuredOutput: { accepted: true },
      }
    },
  }) as ToolRegistration
  return defineExtension({ name: STRUCTURED_OUTPUT_EXTENSION_NAME, tools: [tool] }) as Extension
}

/** Reject $async at the declaration boundary: AJV async validation returns a Promise, and a truthy boolean check
 * would silently let invalid data pass (honesty invariant). */
export function assertSchemaNotAsync(schema: Record<string, unknown>): void {
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmxError(
      'invalid_plugin_schema',
      'schema contains $async: native subagent synchronous validation boundary does not support async Schemas',
      400,
    )
  }
}

/** Full AJV validation (reuses plugins/schema; $async is already rejected at compile time). */
function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; errors: string } {
  try {
    validateOrThrow(schema, value, 'structured output validation failed', 'schema_validation_failed', 502)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof HelmxError && error.code === 'schema_validation_failed') {
      return { ok: false, errors: error.message }
    }
    throw error
  }
}

/** Extract JSON candidates from text and validate against full Schema; supports any valid JSON top-level value (null/bool/number/string/multiline). */
export function parseSchemaCandidate(
  text: string,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; raw: string } {
  for (const candidate of extractJsonCandidates(text)) {
    const result = validateAgainstSchema(candidate, schema)
    if (result.ok) return { ok: true, value: result.value }
  }
  return { ok: false, raw: text }
}

function extractJsonCandidates(text: string): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  const push = (value: unknown) => {
    const key = JSON.stringify(value)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(value)
    }
  }
  // 1) Fenced json blocks (highest priority: explicit intent markers).
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  for (const match of text.matchAll(fenced)) {
    const parsed = safeParse(match[1] ?? '')
    if (parsed !== undefined) push(parsed)
  }
  // 2) Balanced scan for all {...} / [...] literals (handles multiline; later occurrences take precedence when reversed).
  const bracketed = scanBalanced(text)
  for (const candidate of bracketed) push(candidate)
  // 3) Whole text as valid JSON (handles scalar top-levels like null/true/42/"text").
  const whole = safeParse(text)
  if (whole !== undefined) push(whole)
  return out
}

/** Scan text for all balanced {...}/[...] fragments, returning parsed values in order of appearance. */
function scanBalanced(text: string): unknown[] {
  const results: unknown[] = []
  const stack: Array<{ start: number; ch: string }> = []
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push({ start: i, ch })
      continue
    }
    if ((ch === '}' || ch === ']') && stack.length > 0) {
      const open = stack[stack.length - 1] as { start: number; ch: string }
      if ((ch === '}' && open.ch === '{') || (ch === ']' && open.ch === '[')) {
        stack.pop()
        if (stack.length === 0) {
          // Top-level pair closed: whole fragment is a candidate (nested sub-objects stay inside outer object without duplication).
          const parsed = safeParse(text.slice(open.start, i + 1))
          if (parsed !== undefined) results.push(parsed)
        }
      } else {
        // Mismatched brackets (e.g., '}' when stack top is '['): discard current fragment to avoid extracting corrupt JSON.
        stack.length = 0
      }
    }
  }
  return results
}

function safeParse(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/**
 * Validate structured output payload (supporting string-encoded JSON from transport layers),
 * shared by register_structured_output tool and cross-restart entry recovery scan.
 */
function validateStructuredOutputPayload(
  payload: unknown,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; errors: string } {
  const direct = validateAgainstSchema(payload, schema)
  if (direct.ok) return direct
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload)
      const retried = validateAgainstSchema(parsed, schema)
      if (retried.ok) return retried
    } catch {
      // Invalid JSON string; keep initial validation errors
    }
  }
  return direct
}

interface StructuredOutputScanEntry {
  readonly kind: string
  readonly model?: ReadonlyArray<unknown>
}

/**
 * Scan persisted entries of a child conversation starting from submission.entry and return
 * the last non-error schema-valid register_structured_output tool call argument across restarts.
 */
export function extractAcceptedStructuredOutputFromEntries(
  entries: ReadonlyArray<StructuredOutputScanEntry>,
  schema: Record<string, unknown>,
): { found: true; value: unknown } | { found: false } {
  const callsById = new Map<string, Record<string, unknown>>()
  let accepted: { found: true; value: unknown } | undefined

  for (const entry of entries) {
    if (!Array.isArray(entry.model)) continue
    if (entry.kind === 'pi.assistant') {
      for (const msg of entry.model) {
        if (msg === null || typeof msg !== 'object') continue
        const m = msg as { role?: unknown; content?: unknown }
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const block of m.content) {
          if (block === null || typeof block !== 'object') continue
          const b = block as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown; argumentsError?: unknown }
          if (
            b.type === 'toolCall' &&
            b.name === 'register_structured_output' &&
            typeof b.id === 'string' &&
            b.argumentsError === undefined &&
            b.arguments !== null &&
            typeof b.arguments === 'object' &&
            !Array.isArray(b.arguments)
          ) {
            callsById.set(b.id, b.arguments as Record<string, unknown>)
          }
        }
      }
      continue
    }
    if (entry.kind === 'pi.tool-result') {
      for (const msg of entry.model) {
        if (msg === null || typeof msg !== 'object') continue
        const m = msg as { role?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown }
        if (
          m.role !== 'toolResult' ||
          m.toolName !== 'register_structured_output' ||
          typeof m.toolCallId !== 'string' ||
          m.isError !== false
        ) {
          continue
        }
        const args = callsById.get(m.toolCallId)
        if (args === undefined || !Object.hasOwn(args, 'output')) continue
        const verdict = validateStructuredOutputPayload(args['output'], schema)
        if (verdict.ok) {
          accepted = { found: true, value: verdict.value }
        }
      }
    }
  }

  return accepted ?? { found: false }
}

/**
 * Compatibility entrypoint: full AJV validation (reuses plugins/schema; rejects $async explicitly).
 * Preserved for existing consumers; equivalent to wrapping validateOrThrow in a boolean result.
 */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const result = validateAgainstSchema(value, schema)
  return result.ok ? { ok: true, errors: [] } : { ok: false, errors: [result.errors] }
}
