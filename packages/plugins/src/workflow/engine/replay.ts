import { hasValidScopeIdentity, type JournalScope, type WorkflowJournalEntry } from './journal.js'

export type ReplayScope = JournalScope

type SettledEntry = Exclude<WorkflowJournalEntry, { type: 'action_started' }>

export interface ReplayResult {
  hit: boolean
  entry?: SettledEntry
  conflictError?: string
}

/** Global indices describe this run; stable scope coordinates describe the script. */
export class JournalReplay {
  private readonly settled = new Map<string, SettledEntry>()
  private readonly scopes = new Set<string>()
  private readonly broken = new Set<string>()
  private readonly consumedActions = new Set<WorkflowJournalEntry>()

  constructor(private readonly entries: readonly WorkflowJournalEntry[]) {
    // Appending the new run must never extend the recovery snapshot.
    this.entries = [...entries]
    for (const entry of this.entries) {
      if (!hasValidScopeIdentity(entry)) throw new Error('workflow_action_uncertain: invalid journal scope identity')
      this.scopes.add(entry.scopePath)
      if (entry.type === 'action_started') continue
      const key = this.key(entry, entry.type === 'agent' ? entry.attempt ?? 1 : 1)
      if (this.settled.has(key)) {
        throw new Error(`workflow_action_uncertain: duplicate journal coordinate ${key}`)
      }
      this.settled.set(key, entry)
    }
  }

  private key(scope: ReplayScope, attempt: number): string {
    return JSON.stringify([scope.scopePath, scope.scopeCallIndex, attempt])
  }

  history(scope: ReplayScope, attempt = 1): SettledEntry | undefined {
    return this.settled.get(this.key(scope, attempt))
  }

  private isBroken(path: string): boolean {
    for (const parent of this.broken) {
      if (path === parent || path.startsWith(`${parent}/`)) return true
    }
    return false
  }

  match(scope: ReplayScope, key: string, kind: 'agent' | 'action', options: {
    attempt?: number
    allowFailure?: boolean
    resumed?: boolean
  } = {}): ReplayResult {
    if (this.isBroken(scope.scopePath)) return this.miss(scope)
    const entry = this.history(scope, options.attempt)
    if (
      entry === undefined || entry.type !== kind || entry.key !== key ||
      (!entry.ok && !(entry.type === 'agent' && options.allowFailure === true && entry.attempt !== undefined)) ||
      (entry.type === 'agent' && options.resumed !== undefined && (entry.resumed === true) !== options.resumed)
    ) return this.miss(scope)
    return { hit: true, entry }
  }

  consumeAction(entry: WorkflowJournalEntry): void {
    this.consumedActions.add(entry)
    for (const intent of this.entries) {
      if (intent.type === 'action_started' && intent.scopePath === entry.scopePath &&
        intent.scopeCallIndex === entry.scopeCallIndex && intent.index === entry.index && intent.key === entry.key) {
        this.consumedActions.add(intent)
      }
    }
  }

  miss(scope: ReplayScope): ReplayResult {
    this.broken.add(scope.scopePath)
    const childPrefix = `${scope.scopePath}/`
    const uncertain = this.entries.some((entry) => {
      if ((entry.type !== 'action' && entry.type !== 'action_started') || entry.idempotent === true || this.consumedActions.has(entry)) return false
      // A new scope may be a moved call site. Keep unknown coordinates closed
      // until previous non-idempotent effects have been accounted for.
      if (!this.scopes.has(scope.scopePath)) return true
      if (entry.scopePath === scope.scopePath) return entry.scopeCallIndex >= scope.scopeCallIndex
      return entry.scopePath.startsWith(childPrefix) || scope.scopePath.startsWith(`${entry.scopePath}/`)
    })
    return uncertain ? {
      hit: false,
      conflictError: `workflow_action_uncertain: journal replay broke prefix at ${scope.scopePath}:${scope.scopeCallIndex}, ` +
        'but the remaining journal suffix contains non-idempotent action(s). Automatic live rerun would risk repeating external side effects.',
    } : { hit: false }
  }
}
