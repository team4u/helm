/**
 * builtin:tasks 模型执行文案构造（100% 纯函数、固定英文，供测试锁定字节恒定性）。
 *
 * activeTaskSection 是注入任务执行会话的系统提示词段：仅含任务生命周期内
 * 恒定不变的事实（id / title），零可变状态，保证字节恒定（与 swarm 的
 * <active_swarm_group> 同一纪律）。
 *
 * 诚实边界：插件对 human-owned 执行会话零自动输入投递（AGENTS Watchdog 红线）；
 * 需要人类决策时由执行者自己发 Ask，交卷门禁由 task_submit 生命周期承担。
 */
import { escapeXml } from '@helmx/protocol'
import type { TaskRecord } from './contracts.js'

/** before_turn 注入的恒定 <active_task> 系统段落。 */
export function activeTaskSection(task: TaskRecord): string {
  return [
    `<active_task id="${escapeXml(task.id)}" title="${escapeXml(task.title)}">`,
    '1. You are the assignee of this board task. Deliver exactly the scope defined in the task brief you received at kickoff; do not silently expand or shrink it.',
    '2. You keep full orchestration rights: work directly for small changes, or delegate via subagent / SubagentWorkflow / Swarm as complexity warrants.',
    '3. When the work meets the acceptance criteria, you MUST call task_submit with a summary (plus verification evidence, branch, changed files) to hand it in for review. Do not end silently without submitting or asking.',
    '4. If you need a human decision or hit a blocker, ask a clear question (Ask) instead of stalling or guessing.',
    '</active_task>',
  ].join('\n')
}

/** 开工任务书（首条输入；含完整 brief 原文与执行/交卷规则）。 */
export function buildTaskKickoffPrompt(task: TaskRecord): string {
  return [
    `<task_kickoff id="${task.id}">`,
    `# Task ${task.id}: ${task.title}`,
    '',
    '## Brief',
    task.brief,
    '',
    '## Execution rules',
    '- You keep full orchestration rights: work directly for small changes, or delegate via subagent / SubagentWorkflow / Swarm as complexity warrants.',
    '- When done, call task_submit with a summary (plus verification evidence, branch, changed files). Do not end silently.',
    '- If you need a human decision or hit a blocker, ask a clear question instead of stalling.',
    '</task_kickoff>',
  ].join('\n')
}

/** 返工投递：保留原任务上下文，附返工意见。 */
export function buildReworkDeliveryPrompt(task: TaskRecord, feedback: string, options?: { recreated?: boolean }): string {
  return [
    `<task_rework id="${task.id}">`,
    ...(options?.recreated === true
      ? [
          `Your previous execution conversation for task ${task.id} was removed, so this is a fresh start. Original brief:`,
          '',
          task.brief,
          '',
        ]
      : []),
    `Task ${task.id} was sent back for rework (reviewer rejected the submission).`,
    '',
    'Reviewer feedback:',
    feedback,
    '',
    'Fix the issues on your existing branch (keep prior work and context), verify, then call task_submit again.',
    '</task_rework>',
  ].join('\n')
}
