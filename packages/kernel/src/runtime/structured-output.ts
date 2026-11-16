/**
 * original generate subagent structure output (self spawn.ts split out).
 *
 * - register_structured_output tool:AJV all amount validate (re- use plugins/schema,$async
 *   explicit reject), tool reject error parameter same turn retry; result slot by conversation isolated, via inject
 *   sessions Map(host per-Harness hold has, alternative original module level global WeakMap) motion state locate;
 * - text self-heal extract:extractJsonCandidates / scanBalanced(balance scan all {...}/[...]
 *   literal, contains across row), first fenced json block, after balance scan, again whole text.
 */

import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { HelmError } from '@helm/protocol'
import { validateOrThrow } from '../plugins/schema.js'

/** original generate subagent structure output extension call (supply install and fork strip shared use). */
export const STRUCTURED_OUTPUT_EXTENSION_NAME = 'helm-structured-output'

/** single conversation structure output task slot:schema + already accept result (undefined = not yet accept). */
export interface StructuredOutputSession {
  schema: Record<string, unknown>
  accepted: unknown | undefined
}

/**
 * construct helm-structured-output extend (tool define can re- use; same name heavy install is original ground replace).
 * result slot by inject sessions Map locate (per-request instance, by conversationId isolated).
 */
export function buildStructuredOutputExtension(sessions: Map<number, StructuredOutputSession>): Extension {
  const tool: ToolRegistration = defineTool({
    name: 'register_structured_output',
    description:
      'commit eventually structure result.output must satisfy task to set JSON Schema; validation failed will receives error and by want seek retry.',
    parameters: {
      type: 'object',
      properties: {
        output: {
          description: 'satisfy task JSON Schema structure result (any JSON value, contains null)',
        },
      },
      required: ['output'],
      // output value shape by task Schema all amount validate, this in do not restrict its internal structure.
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
        return { output: [{ type: 'text', text: 'when before conversation no in-flight structure output task.' }], isError: true }
      }
      let payload = (args as { output?: unknown }).output
      let result = validateAgainstSchema(payload, session.schema)
      // guard against defend deserialization: if initial validate not via and reference is string, attempt JSON.parse after again validate
      // (compatibility model because without strong type declaration or transfer layer serialization while structure JSON encode is string scenario).
      if (!result.ok && typeof payload === 'string') {
        try {
          const parsed = JSON.parse(payload)
          const secondResult = validateAgainstSchema(parsed, session.schema)
          if (secondResult.ok) {
            payload = parsed
            result = secondResult
          }
        } catch {
          // non- legal JSON string, keep initial validate errors
        }
      }
      if (!result.ok) {
        return {
          output: [
            {
              type: 'text',
              text:
                `structure output validation failed, please fix correct after re- invoke register_structured_output:\n${result.errors}` +
                `\n\nSchema: ${JSON.stringify(session.schema)}`,
            },
          ],
          isError: true,
        }
      }
      session.accepted = payload
      return {
        output: [{ type: 'text', text: 'structure output already accept.' }],
        structuredOutput: { accepted: true },
      }
    },
  }) as ToolRegistration
  return defineExtension({ name: STRUCTURED_OUTPUT_EXTENSION_NAME, tools: [tool] }) as Extension
}

/** declaration boundary i.e. reject $async:AJV async validate return Promise, sync boolean decide will
 *  Promise when truthy let through illegal data (honest hard rule). */
export function assertSchemaNotAsync(schema: Record<string, unknown>): void {
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmError(
      'invalid_plugin_schema',
      `schema contains $async: original generate subagent sync validate boundary unsupported async Schema`,
      400,
    )
  }
}

/** AJV all amount validate (re- use plugins/schema;$async in compile time already reject). */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; errors: string } {
  try {
    validateOrThrow(schema, value, 'structure output validation failed', 'schema_validation_failed', 502)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof HelmError && error.code === 'schema_validation_failed') {
      return { ok: false, errors: error.message }
    }
    throw error
  }
}

/** from text extract choose and do all amount Schema validate; support any legal JSON top-level (null/bool/number/string/across row). */
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
  // 1) fenced json block(takes precedence: explicit intent mark record).
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  for (const match of text.matchAll(fenced)) {
    const parsed = safeParse(match[1] ?? '')
    if (parsed !== undefined) push(parsed)
  }
  // 2) balance scan extract all {...} / [...] literal (contains across row; after appear takes precedence,unshift keep order reverse order).
  const bracketed = scanBalanced(text)
  for (const candidate of bracketed) push(candidate)
  // 3) whole text is legal JSON(null/true/42/"text" etc. mark amount top-level).
  const whole = safeParse(text)
  if (whole !== undefined) push(whole)
  return out
}

/** scan text in all balance {...}/[...] fragment, return by appear order parse result. */
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
          // top-level closed together: the whole fragment is choose (embed set sub- object by outside layer override, does not repeat extract).
          const parsed = safeParse(text.slice(open.start, i + 1))
          if (parsed !== undefined) results.push(parsed)
        }
      } else {
        // do not balance (such as "}" appear but stack top is "["): discard when before fragment, guard against extract leftover missing JSON.
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
 * compatibility entry: complete AJV validate (plugins/schema re- use;$async explicit reject).
 * keep export supply since has consumer; behavior etc. price validateOrThrow  boolean wrap.
 */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
): { ok: boolean; errors: string[] } {
  const result = validateAgainstSchema(value, schema)
  return result.ok ? { ok: true, errors: [] } : { ok: false, errors: [result.errors] }
}
