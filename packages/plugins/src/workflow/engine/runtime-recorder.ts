/**
 * runtime-recorder.ts — agent 行尽力记账器。
 *
 * 自 runtime.ts 的 recordAgent 闭包类化（语义逐行保持）：
 * agent 行记账尽力而为：写失败不中断 run（resume 优化损失），错误记入
 * ioErrors 随 WorkflowRunResult.journalIoErrors 暴露，绝不隐瞒。
 * action 行不走本器——副作用行写失败是 fatal，由 action handler 直写
 * appendJournal 并显式报 workflow_action_uncertain。
 */

import { redactJournalEntry, type JournalWriteInput } from './journal.js'

/** agent 行输入：不带 type/seq（type 由本层补齐，seq 由写入器分配）。 */
export type AgentRecordInput = Omit<Extract<JournalWriteInput, { type: 'agent' }>, 'type' | 'seq'>

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
}
