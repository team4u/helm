/**
 * runtime-recorder.ts -- the best-effort ledger writer for agent rows.
 *
 * Class-ized from runtime.ts's recordAgent closure (semantics preserved line by line):
 * agent-row accounting is best-effort: a write failure does not interrupt the run (a resume
 * optimization loss); errors are recorded into ioErrors, exposed via
 * WorkflowRunResult.journalIoErrors, never concealed.
 * action rows do not go through this writer -- a side-effect row write failure is fatal; the action handler
 * writes appendJournal directly and reports workflow_action_uncertain explicitly.
 */

import { redactJournalEntry, type JournalWriteInput } from './journal.js'

/** agent-row input: without type/seq (type is added by this layer, seq assigned by the writer). */
export type AgentRecordInput = Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq'>
/** agent_started 行输入：不带 type/seq。 */
export type AgentStartedRecordInput = Omit<Extract<JournalWriteInput, { type: 'agent_started' }>, 'type' | 'seq'>

export class AgentJournalRecorder {
  readonly ioErrors: string[] = []

  constructor(
    private readonly append: ((entry: JournalWriteInput) => Promise<void> | void) | undefined,
    private readonly redactText: (text: string) => string,
  ) {}

  async record(entry: AgentRecordInput): Promise<void> {
    if (this.append === undefined) return
    try {
      await this.append(redactJournalEntry({ ...entry, type: 'agent' }, this.redactText))
    } catch (error) {
      this.ioErrors.push(error instanceof Error ? error.message : String(error))
    }
  }

  async recordStarted(entry: AgentStartedRecordInput): Promise<void> {
    if (this.append === undefined) return
    try {
      await this.append(redactJournalEntry({ ...entry, type: 'agent_started' }, this.redactText))
    } catch (error) {
      this.ioErrors.push(error instanceof Error ? error.message : String(error))
    }
  }
}
