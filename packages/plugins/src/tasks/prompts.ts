/**
 * builtin:tasks 模型执行文案构造（100% 纯函数、固定英文，供测试锁定字节恒定性）。
 *
 * activeTaskSection 是注入任务执行会话的系统提示词段：仅含任务生命周期内
 * 恒定不变的事实（id / title / planFirst / autoMerge），零可变状态，保证
 * 字节恒定（与 swarm 的 <active_swarm_group> 同一纪律）。
 *
 * 诚实边界：插件对 human-owned 执行会话零自动输入投递（AGENTS Watchdog 红线）；
 * planFirst 的方案审批走执行者发起的真实 Ask（内核 AskDoc：pendingAskCount > 0、
 * 看板如实显示 blocked），门禁范围见 docs/plugins/tasks.md。
 */
import { escapeXml } from '@helmx/protocol'
import type { TaskRecord } from './contracts.js'

/** before_turn 注入的恒定 <active_task> 系统段落。 */
export function activeTaskSection(task: TaskRecord): string {
  return [
    `<active_task id="${escapeXml(task.id)}" title="${escapeXml(task.title)}" plan-first="${task.planFirst === true}" auto-merge="${task.autoMerge === true}">`,
    '1. You are the assignee of this board task. Deliver exactly the scope defined in the task brief you received at kickoff; do not silently expand or shrink it.',
    ...(task.planFirst === true
      ? [
          '2. planFirst is ON: investigate first, then call task_request_plan_approval with your concise plan and wait for the explicit user decision (a real Ask card). Do not write code before the plan is approved; if rejected, revise the plan and ask again. While the approval is pending the board honestly shows this task as blocked on a human decision, and task_submit is refused.',
        ]
      : ['2. planFirst is OFF: you may start working directly, but still think before large changes.']),
    ...(task.autoMerge === true
      ? ['3. autoMerge is ON: after verification passes you may merge your isolated branch following the project merge rules, then submit.']
      : ['3. autoMerge is OFF: develop on an isolated branch and NEVER merge into the main line yourself; submit your branch for review instead.']),
    '4. You keep full orchestration rights: work directly for small changes, or delegate via subagent / SubagentWorkflow / Swarm as complexity warrants.',
    '5. When the work meets the acceptance criteria, you MUST call task_submit with a summary (plus verification evidence, branch, changed files) to hand it in for review. Do not end silently without submitting or asking.',
    '6. If you need a human decision or hit a blocker, ask a clear question (Ask) instead of stalling or guessing.',
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
    ...(task.planFirst === true
      ? [
          '- planFirst is ON: investigate, then call task_request_plan_approval with your concise plan and wait for the explicit user decision; do not write code before approval (task_submit is refused until the plan is approved).',
        ]
      : ['- planFirst is OFF: you may start working directly.']),
    ...(task.autoMerge === true
      ? ['- autoMerge is ON: after verification passes you may merge your isolated branch following the project merge rules, then submit.']
      : ['- autoMerge is OFF: develop on an isolated branch and NEVER merge into the main line yourself; submit your branch for review.']),
    '- You keep full orchestration rights: work directly for small changes, or delegate via subagent / SubagentWorkflow / Swarm as complexity warrants.',
    '- When done, call task_submit with a summary (plus verification evidence, branch, changed files). Do not end silently.',
    '- If you need a human decision or hit a blocker, ask a clear question instead of stalling.',
    '</task_kickoff>',
  ].join('\n')
}

/** merge_and_close 验收指令：用户已显式授权本次合并（覆盖 autoMerge=false 的默认隔离），合并回执一步结单。 */
export function buildMergeClosingPrompt(task: TaskRecord, note?: string): string {
  return [
    `<task_merge_closing id="${task.id}">`,
    `Task ${task.id} passed review and the reviewer explicitly authorized merging it now (this overrides the task's autoMerge=false isolation default for this closure).`,
    '- Merge your isolated branch into the main line following the project merge rules (run the required checks first).',
    '- Clean up any temporary worktree you created.',
    `- Then call task_submit with the merge result, setting merged: true explicitly (plus the branch and verification evidence such as the merge commit and checks status); only that explicit declaration completes task ${task.id} — no second manual approval is needed. A submission without merged: true stays in review.`,
    ...(note !== undefined && note.trim() !== '' ? ['', `Reviewer note: ${note.trim()}`] : []),
    '</task_merge_closing>',
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
