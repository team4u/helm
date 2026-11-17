/**
 * On-demand Mermaid runtime loader (pure .ts module — Fast Refresh friendly).
 *
 * - Keeps the entry bundle free of mermaid's core parser/layout runtime until a
 *   diagram actually renders;
 * - Deduplicates concurrent loadMermaid() callers onto one in-flight Promise;
 * - Clears the cached Promise on failure so retries after transient chunk /
 *   network failures can re-import rather than staying wedged forever.
 */
import type { Mermaid } from 'mermaid'

export type MermaidImporter = () => Promise<{ default?: Mermaid } | Mermaid>

export interface MermaidLoader {
  load: () => Promise<Mermaid>
  reset: () => void
}

const importDefaultMermaid: MermaidImporter = () => import('mermaid')

/**
 * Create a deduplicated, retry-safe Mermaid loader around a dynamic importer.
 */
export function createMermaidLoader(importer: MermaidImporter = importDefaultMermaid): MermaidLoader {
  let currentAttempt: Promise<Mermaid> | null = null

  const load = (): Promise<Mermaid> => {
    if (currentAttempt !== null) return currentAttempt

    const run = (async () => {
      const mod = await importer()
      const instance =
        mod !== null && typeof mod === 'object' && 'default' in mod && mod.default !== undefined
          ? mod.default
          : (mod as Mermaid)
      if (
        !instance ||
        typeof instance.initialize !== 'function' ||
        typeof instance.render !== 'function'
      ) {
        throw new Error('Loaded mermaid module is missing initialize/render')
      }
      return instance
    })()

    const attempt = run.catch((err: unknown) => {
      // Clear only if this attempt is still the active cached entry so a
      // newer retry or explicit reset is never overwritten by a stale error.
      if (currentAttempt === attempt) {
        currentAttempt = null
      }
      throw err
    })

    currentAttempt = attempt
    return attempt
  }

  const reset = (): void => {
    currentAttempt = null
  }

  return { load, reset }
}

const defaultMermaidLoader = createMermaidLoader()

/**
 * Load the Mermaid runtime singleton on demand. Concurrent calls share one
 * in-flight Promise; load failures clear the cache so subsequent retries work.
 */
export function loadMermaid(): Promise<Mermaid> {
  return defaultMermaidLoader.load()
}
