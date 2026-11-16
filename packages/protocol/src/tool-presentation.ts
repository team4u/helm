/** Actual execution result of the built-in edit tool; presentation only consumes diffs corresponding to the written file. */
export type ToolDiffRow =
  | { kind: 'context'; oldLine: number; newLine: number; text: string }
  | { kind: 'remove'; oldLine: number; text: string }
  | { kind: 'add'; newLine: number; text: string }

export interface ToolEditDiff {
  rows: ToolDiffRow[]
  addedLines: number
  removedLines: number
  firstChangedLine: number
  /** Row or text budget caused part of the diff to be omitted; the counters still cover the whole replacement. */
  truncated: boolean
}

export interface EditToolResult {
  path: string
  nodeId: string
  replaced: true
  diff: ToolEditDiff
}

export const TOOL_DIFF_MAX_ROWS = 160
export const TOOL_DIFF_MAX_TEXT_CHARS = 32_768
export const TOOL_DIFF_MAX_ROW_CHARS = 4_096

const lineNumber = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
const text = { type: 'string', maxLength: TOOL_DIFF_MAX_ROW_CHARS }

/** SDK output and the Web presentation entry share the same schema, rejecting forged line numbers and invalid data. */
export const EDIT_TOOL_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1 },
    replaced: { const: true },
    diff: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          maxItems: TOOL_DIFF_MAX_ROWS,
          items: {
            oneOf: [
              {
                type: 'object',
                properties: { kind: { const: 'context' }, oldLine: lineNumber, newLine: lineNumber, text },
                required: ['kind', 'oldLine', 'newLine', 'text'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { kind: { const: 'remove' }, oldLine: lineNumber, text },
                required: ['kind', 'oldLine', 'text'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: { kind: { const: 'add' }, newLine: lineNumber, text },
                required: ['kind', 'newLine', 'text'],
                additionalProperties: false,
              },
            ],
          },
        },
        addedLines: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        removedLines: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        firstChangedLine: lineNumber,
        truncated: { type: 'boolean' },
      },
      required: ['rows', 'addedLines', 'removedLines', 'firstChangedLine', 'truncated'],
      additionalProperties: false,
    },
  },
  required: ['path', 'nodeId', 'replaced', 'diff'],
  additionalProperties: false,
}
