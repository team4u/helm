/**
 * Shared timeline-entry text extraction for server-side plugin settlement summaries.
 *
 * Contract: an entry's `model` field is the pi-ai message array of that entry's record. Entries of kind
 * `pi.tool-result` carry `{ role: 'toolResult', content: [{ type: 'text', ... }] }` messages and user-side
 * entries (steers, onYield continuations) can carry `{ role: 'user', content: [{ type: 'text', ... }] }`
 * blocks — all shaped exactly like assistant text blocks. Extracting "the last assistant reply" therefore
 * MUST match on `role === 'assistant'`: without the role check, a tool's raw output (e.g. a bash listing)
 * or an injected user text is returned as the member's reply summary.
 */

/** Last assistant text across entries (newest first, message-role checked; '' when none). */
export function lastAssistantText(entries: Array<{ kind?: string; model?: unknown }>): string {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const model = entries[i]!.model
    if (!Array.isArray(model)) continue
    for (let j = model.length - 1; j >= 0; j -= 1) {
      const message = model[j] as { role?: unknown; content?: unknown } | null | undefined
      if (message === null || typeof message !== 'object' || message.role !== 'assistant') continue
      const blocks = message.content
      if (!Array.isArray(blocks)) continue
      const texts = blocks
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === 'object' &&
            b !== null &&
            (b as { type?: string }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
      if (texts.length > 0) return texts.join('\n')
    }
  }
  return ''
}
