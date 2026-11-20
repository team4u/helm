/**
 * builtin:swarm 动作与模型工具统一注册入口（按群组 / 成员 / 黑板子模块解耦实现）：
 * - 11 个 `swarm_*` 模型工具均声明结构化 `structuredOutputSchema`，返回 `{ output, structuredOutput }`
 *   （模型读取精简文本摘要，Web 端与调试消费端直接读结构化详情）；
 * - 14 个 `ctx.action`（HTTP / CLI / Workflow / UI 补全）均声明严格 `outputSchema`，
 *   UI 专用补全源设 `exposeToPrompt: false` 避免挤占模型 `<available_actions>` 提示词预算。
 */
import type { HelmxPluginContext, PluginToolContext } from '@helmx/protocol'
import {
  COORDINATOR_SCOPE,
  HISTORY_PARTICIPANT_SCOPE,
  PARTICIPANT_SCOPE,
  type BoardPost,
  type BoardViewDoc,
  type SwarmCoordinator,
} from './contracts.js'
import {
  abortWorkerOutputSchema,
  archiveWorkerInputSchema,
  archiveWorkerOutputSchema,
  boardPostInputSchema,
  boardPostOutputSchema,
  boardReadInputSchema,
  boardReadOutputSchema,
  boardStatusInputSchema,
  boardStatusOutputSchema,
  closeGroupInputSchema,
  closeGroupOutputSchema,
  completerInputSchema,
  completerOutputSchema,
  createGroupInputSchema,
  createGroupOutputSchema,
  dispatchInputSchema,
  dispatchWorkerOutputSchema,
  inspectWorkerOutputSchema,
  manageChannelInputSchema,
  manageChannelOutputSchema,
  switchModelInputSchema,
  switchModelOutputSchema,
  updateGroupInputSchema,
  updateGroupOutputSchema,
  workerIdInputSchema,
} from './action-schemas.js'
import {
  checkCoordinatorEligibility,
  createGroupHandlers,
  ensureCoordinatorGroup,
  type EnsureCoordinatorGroupInput,
} from './actions-group.js'
import {
  createWorkerHandlers,
  type DispatchInput,
  type InspectWorkerResult,
} from './actions-worker.js'
import { createBoardHandlers } from './actions-board.js'
import {
  assertWorkerConversationId,
  assertWorkerCwd,
  assertWorkerNodeId,
} from '../entry-text.js'

export {
  assertWorkerConversationId,
  assertWorkerCwd,
  assertWorkerNodeId,
  checkCoordinatorEligibility,
  ensureCoordinatorGroup,
  type DispatchInput,
  type EnsureCoordinatorGroupInput,
}

function envelope<T>(output: string, structuredOutput: T): { output: string; structuredOutput: T } {
  return { output, structuredOutput }
}

function formatBoardPostLine(p: BoardPost): string {
  const wt =
    p.worktreeSnapshot !== undefined
      ? ` [worktree ${p.worktreeSnapshot.branch ?? p.worktreeSnapshot.worktreeId}: dirty=${p.worktreeSnapshot.dirtyCount}${p.worktreeSnapshot.commitsAhead !== undefined ? `, +${p.worktreeSnapshot.commitsAhead}` : ''}]`
      : ''
  const refs = p.refs.length > 0 ? ` refs=${p.refs.map((r) => `#${r}`).join(',')}` : ''
  return `#${p.seq} [${p.channel}/${p.kind}] ${p.from} -> ${p.to.join(', ')}${refs}${wt}: ${p.body}`
}

function formatBoardStatusSummary(view: BoardViewDoc): string {
  const lines: string[] = [
    `Group "${view.group.title}" (${view.group.id}, status=${view.group.status}, headSeq=${view.group.headSeq})`,
    `Headline [${view.headline.tone}/${view.headline.kind}]: ${view.headline.text}`,
  ]
  if (view.activeWorkingMembers.length > 0) {
    lines.push(`Active working members: ${view.activeWorkingMembers.map((m) => `@${m}`).join(', ')}`)
  }
  if (view.members.length > 0) {
    lines.push(
      `Members (${view.members.length}): ${view.members
        .map(
          (m) =>
            `@${m.name} (#${m.conversationId}, ${m.lifecycle}, ${m.liveState}, cursor=${m.readCursorSeq}/${m.pendingWakeupSeq}${m.worktreeId !== undefined ? `, worktree=${m.worktreeId}` : ''})`,
        )
        .join('; ')}`,
    )
  }
  if (view.group.retainedWorktrees !== undefined && view.group.retainedWorktrees.length > 0) {
    lines.push(
      `Retained worktrees: ${view.group.retainedWorktrees
        .map((w) => `@${w.memberName}:${w.branch} (+${w.commitsAhead}, ${w.path})`)
        .join('; ')}`,
    )
  }
  if (view.posts.length > 0) {
    const recent = view.posts.slice(-5).map((p) => formatBoardPostLine(p))
    lines.push(`Recent posts (${recent.length}/${view.posts.length}):\n${recent.join('\n')}`)
  }
  return lines.join('\n')
}

function makeToolCallKey(
  conversationId: number | undefined,
  callId: string | undefined,
): string | undefined {
  if (conversationId === undefined || callId === undefined || callId.trim() === '') return undefined
  return `${conversationId}:${callId}`
}

function formatInspectWorkerSummary(res: InspectWorkerResult): string {
  const header = `Member @${res.name} (#${res.conversationId}, group=${res.groupId}, profile=${res.profileId}, status=${res.status}${res.worktreeId !== undefined ? `, worktree=${res.worktreeId}` : ''}${res.doing !== null ? `, doing="${res.doing}"` : ''}, artifacts=${res.artifacts.length})`
  if (res.recentEntries.length === 0) return header
  const entries = res.recentEntries.slice(-5).map((e) => `- [${e.kind}] ${e.text}`)
  return `${header}\nRecent timeline (${entries.length}/${res.recentEntries.length}):\n${entries.join('\n')}`
}

export function registerSwarmActions(
  ctx: HelmxPluginContext,
  coordinator: SwarmCoordinator,
): void {
  const { createGroup, updateGroup, manageChannel, closeGroup } = createGroupHandlers(ctx, coordinator)
  const { dispatchWorker, abortWorker, switchWorkerModel, inspectWorker, archiveWorker } =
    createWorkerHandlers(ctx, coordinator)
  const { boardPost, boardRead, boardStatus, completeBoardMembers, completeBoardChannels } =
    createBoardHandlers(ctx, coordinator)

  // ------------------------------------------------------------------
  // ctx.tool（统一 swarm_ 前缀，声明 structuredOutputSchema + 精简文本输出）
  // ------------------------------------------------------------------
  ctx.tool({
    name: 'swarm_create_group',
    description:
      'Start an active peer swarm collaboration board on the current top-level human conversation, tagging it swarm-coordinator and unlocking squad tools next step. Use for complex tasks needing concurrent role division, live peer handoffs, or writer/verifier review loops; skip for single subtasks or fixed deterministic pipelines.',
    promptSnippet:
      'Start a coordinated multi-agent peer blackboard collaboration (`swarm_create_group`) when dividing non-overlapping work across multiple concurrent peer agents.',
    promptGuidelines: [
      'Use swarm_create_group only in a top-level human conversation when dynamic parallel division, live peer handoffs, or writer/reviewer verification warrants a peer squad.',
      'Do not use swarm_create_group for small sequential tasks, single subtasks, or fixed deterministic pipelines (use subagent / SubagentWorkflow when available).',
      'Once active, call load_skill({ skillId: "swarm" }) when available before dispatching workers via swarm_dispatch_worker.',
    ],
    inputSchema: createGroupInputSchema,
    structuredOutputSchema: createGroupOutputSchema,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await createGroup(
        input as Parameters<typeof createGroup>[0],
        context.conversationId,
        makeToolCallKey(context.conversationId, context.callId),
      )
      return envelope(`Created swarm group "${res.group.title}" (${res.groupId}).`, res)
    },
  })

  ctx.tool({
    name: 'swarm_update_group',
    description: 'Update the active swarm collaboration group title or objective.',
    inputSchema: updateGroupInputSchema,
    structuredOutputSchema: updateGroupOutputSchema,
    scope: COORDINATOR_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await updateGroup(input as Parameters<typeof updateGroup>[0], context.conversationId)
      return envelope(`Updated swarm group "${res.group.title}" (${res.groupId}).`, res)
    },
  })

  ctx.tool({
    name: 'swarm_dispatch_worker',
    description:
      'Recruit a named peer role into the active swarm collaboration group with optional worktree isolation and clean-anchor conversation forking.',
    inputSchema: dispatchInputSchema,
    structuredOutputSchema: dispatchWorkerOutputSchema,
    scope: COORDINATOR_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await dispatchWorker(
        input as DispatchInput,
        context.conversationId,
        context.signal,
        makeToolCallKey(context.conversationId, context.callId),
      )
      return envelope(
        `Dispatched @${res.name} (#${res.workerConversationId}) in group ${res.groupId}${res.worktreeId !== undefined ? `, worktree=${res.worktreeId}` : ''}, brief=#${res.postSeq}.`,
        res,
      )
    },
  })

  ctx.tool({
    name: 'swarm_board_post',
    description:
      'Publish a structured message on the swarm collaboration board with deterministic target resolution and orthogonal wake control (handoff and done posts from worktree members automatically attach a worktree snapshot).',
    inputSchema: boardPostInputSchema,
    structuredOutputSchema: boardPostOutputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await boardPost(
        input as Parameters<typeof boardPost>[0],
        context.conversationId,
        context.signal,
        makeToolCallKey(context.conversationId, context.callId),
      )
      const targets = res.post.resolvedTargets.length > 0 ? res.post.resolvedTargets : res.post.to
      return envelope(
        `Posted #${res.post.seq} [${res.post.kind}] in #${res.post.channel} -> ${targets.join(', ')} (wake=${res.post.wake}).`,
        res,
      )
    },
  })

  ctx.tool({
    name: 'swarm_board_read',
    description: 'Read swarm collaboration board posts by channel, sinceSeq, or exact seqs.',
    inputSchema: boardReadInputSchema,
    structuredOutputSchema: boardReadOutputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await boardRead(input as Parameters<typeof boardRead>[0], context.conversationId)
      const text =
        res.posts.length === 0
          ? `No matching board posts in ${res.groupId} (headSeq=${res.headSeq}).`
          : `Board ${res.groupId} (headSeq=${res.headSeq}, returned=${res.posts.length}):\n${res.posts.map(formatBoardPostLine).join('\n')}`
      return envelope(text, res)
    },
  })

  ctx.tool({
    name: 'swarm_board_status',
    description:
      'Inspect live swarm collaboration group status, member cursors and live states, activeWorkingMembers, handoff edges, and retained worktrees.',
    inputSchema: boardStatusInputSchema,
    structuredOutputSchema: boardStatusOutputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await boardStatus(input as { groupId?: string }, context.conversationId)
      return envelope(formatBoardStatusSummary(res), res)
    },
  })

  ctx.tool({
    name: 'swarm_abort_worker',
    description:
      'Stop an in-flight swarm worker turn in place while preserving its conversation history and managed worktree hold for follow-up correction.',
    inputSchema: workerIdInputSchema,
    structuredOutputSchema: abortWorkerOutputSchema,
    scope: COORDINATOR_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await abortWorker(input as Parameters<typeof abortWorker>[0], context.conversationId)
      return envelope(
        res.aborted
          ? `Aborted @${res.name} (#${res.workerConversationId}).`
          : `Member @${res.name} (#${res.workerConversationId}) was not running.`,
        res,
      )
    },
  })

  ctx.tool({
    name: 'swarm_switch_worker_model',
    description: 'Switch an idle swarm worker conversation to another model in place while preserving its conversation history.',
    inputSchema: switchModelInputSchema,
    structuredOutputSchema: switchModelOutputSchema,
    scope: COORDINATOR_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await switchWorkerModel(input as Parameters<typeof switchWorkerModel>[0], context.conversationId)
      return envelope(`Switched @${res.name} (#${res.workerConversationId}) model to ${res.model}.`, res)
    },
  })

  ctx.tool({
    name: 'swarm_inspect_worker',
    description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
    inputSchema: workerIdInputSchema,
    structuredOutputSchema: inspectWorkerOutputSchema,
    scope: PARTICIPANT_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await inspectWorker(input as Parameters<typeof inspectWorker>[0], context.conversationId)
      return envelope(formatInspectWorkerSummary(res), res)
    },
  })

  ctx.tool({
    name: 'swarm_archive_worker',
    description: 'Archive an idle swarm worker (verifying worktree merge safety and releasing worktree holds when applicable).',
    inputSchema: archiveWorkerInputSchema,
    structuredOutputSchema: archiveWorkerOutputSchema,
    scope: COORDINATOR_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await archiveWorker(input as Parameters<typeof archiveWorker>[0], context.conversationId, context.signal)
      return envelope(`Archived worker #${res.workerConversationId}.`, res)
    },
  })

  ctx.tool({
    name: 'swarm_close_group',
    description:
      'Close the swarm collaboration group in full-cleanup mode or retain-branches mode (keepWorktree: true releases holds and preserves modified branches in retainedWorktrees; force: true closes past the uncommitted/unmerged guard, discarding unmerged member worktree content).',
    inputSchema: closeGroupInputSchema,
    structuredOutputSchema: closeGroupOutputSchema,
    scope: COORDINATOR_SCOPE,
    replay: 'safe',
    execute: async (input: never, context: PluginToolContext) => {
      const res = await closeGroup(input as Parameters<typeof closeGroup>[0], context.conversationId, context.signal)
      const text =
        res.retainedWorktrees.length === 0
          ? `Closed swarm group ${res.groupId} cleanly.`
          : `Closed swarm group ${res.groupId}; retained ${res.retainedWorktrees.length} worktree(s) for merge: ${res.retainedWorktrees.map((w) => `@${w.memberName}:${w.branch} (+${w.commitsAhead})`).join(', ')}.`
      return envelope(text, res)
    },
  })

  // ------------------------------------------------------------------
  // ctx.action（HTTP / CLI / Workflow / Web 五端同源复用，exposeAsTool: false）
  // ------------------------------------------------------------------
  ctx.action({
    id: 'create_group',
    description: 'Create an active swarm collaboration group on a top-level conversation.',
    exposeAsTool: false,
    cli: { command: ['swarm', 'create-group'], description: 'Create an active swarm collaboration group' },
    inputSchema: createGroupInputSchema,
    outputSchema: createGroupOutputSchema,
    handler: (input: Parameters<typeof createGroup>[0], context) => createGroup(input, context.conversationId),
  })

  ctx.action({
    id: 'update_group',
    description: 'Update swarm collaboration group metadata.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'update-group'], description: 'Update swarm collaboration group metadata' },
    inputSchema: updateGroupInputSchema,
    outputSchema: updateGroupOutputSchema,
    handler: (input: Parameters<typeof updateGroup>[0], context) => updateGroup(input, context.conversationId),
  })

  ctx.action({
    id: 'manage_channel',
    description: 'Create, subscribe, unsubscribe, or archive swarm collaboration group subchannels.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'channel'], description: 'Manage swarm collaboration group subchannels' },
    inputSchema: manageChannelInputSchema,
    outputSchema: manageChannelOutputSchema,
    handler: (input: Parameters<typeof manageChannel>[0], context) => manageChannel(input, context.conversationId),
  })

  ctx.action({
    id: 'dispatch_worker',
    description: 'Recruit a named peer worker role into an active swarm collaboration group.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'dispatch-worker'], description: 'Recruit a named swarm peer worker' },
    inputSchema: dispatchInputSchema,
    outputSchema: dispatchWorkerOutputSchema,
    handler: (input: DispatchInput, context) => dispatchWorker(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'board_post',
    description: 'Publish a structured post to the swarm collaboration board.',
    exposeAsTool: false,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-post'], description: 'Publish a post to the swarm collaboration board' },
    inputSchema: boardPostInputSchema,
    outputSchema: boardPostOutputSchema,
    handler: (input: Parameters<typeof boardPost>[0], context) =>
      boardPost(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'board_read',
    description: 'Read posts from the swarm collaboration board.',
    exposeAsTool: false,
    idempotent: true,
    scope: HISTORY_PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-read'], description: 'Read posts from the swarm collaboration board' },
    inputSchema: boardReadInputSchema,
    outputSchema: boardReadOutputSchema,
    handler: (input: Parameters<typeof boardRead>[0], context) => boardRead(input, context.conversationId),
  })

  ctx.action({
    id: 'board_status',
    description: 'Inspect swarm collaboration group board status, members, edges, and retained worktrees.',
    exposeAsTool: false,
    idempotent: true,
    scope: HISTORY_PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'board-status'], description: 'Inspect swarm collaboration group board status' },
    inputSchema: boardStatusInputSchema,
    outputSchema: boardStatusOutputSchema,
    handler: (input: { groupId?: string }, context) => boardStatus(input, context.conversationId),
  })

  ctx.action({
    id: 'abort_worker',
    description: 'Abort an in-flight swarm worker turn in place while preserving conversation history and worktree hold.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'abort-worker'], description: 'Abort an in-flight swarm worker turn in place' },
    inputSchema: workerIdInputSchema,
    outputSchema: abortWorkerOutputSchema,
    handler: (input: Parameters<typeof abortWorker>[0], context) => abortWorker(input, context.conversationId),
  })

  ctx.action({
    id: 'switch_worker_model',
    description: 'Switch an idle swarm worker conversation to another model in place.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'switch-model'], description: 'Switch an idle swarm worker conversation model' },
    inputSchema: switchModelInputSchema,
    outputSchema: switchModelOutputSchema,
    handler: (input: Parameters<typeof switchWorkerModel>[0], context) =>
      switchWorkerModel(input, context.conversationId),
  })

  ctx.action({
    id: 'inspect_worker',
    description: "Read a swarm worker's recent timeline summary, artifact list, and bound worktreeId.",
    exposeAsTool: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { command: ['swarm', 'inspect-worker'], description: 'Inspect a swarm worker' },
    inputSchema: workerIdInputSchema,
    outputSchema: inspectWorkerOutputSchema,
    handler: (input: Parameters<typeof inspectWorker>[0], context) => inspectWorker(input, context.conversationId),
  })

  ctx.action({
    id: 'archive_worker',
    description: 'Archive an idle swarm worker: releases worktree holds and swaps swarm-worker tag for swarm-worker-archived.',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'archive-worker'], description: 'Archive an idle swarm worker' },
    inputSchema: archiveWorkerInputSchema,
    outputSchema: archiveWorkerOutputSchema,
    handler: (input: Parameters<typeof archiveWorker>[0], context) =>
      archiveWorker(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'close_group',
    description:
      'Close a swarm collaboration group in full-cleanup mode, retain-branches mode (keepWorktree: true), or force mode (force: true bypasses only the uncommitted/unmerged worktree guard).',
    exposeAsTool: false,
    scope: COORDINATOR_SCOPE,
    cli: { command: ['swarm', 'close-group'], description: 'Close a swarm collaboration group' },
    inputSchema: closeGroupInputSchema,
    outputSchema: closeGroupOutputSchema,
    handler: (input: Parameters<typeof closeGroup>[0], context) =>
      closeGroup(input, context.conversationId, context.signal),
  })

  ctx.action({
    id: 'complete_board_members',
    description: 'List mentionable swarm collaboration board roles for composer @ completion.',
    exposeAsTool: false,
    exposeToPrompt: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { hidden: true },
    inputSchema: completerInputSchema,
    outputSchema: completerOutputSchema,
    handler: (input: { query?: string; conversationId?: number }, context) =>
      completeBoardMembers(input, context.conversationId),
  })

  ctx.action({
    id: 'complete_board_channels',
    description: 'List active swarm collaboration board subchannels for composer # completion.',
    exposeAsTool: false,
    exposeToPrompt: false,
    idempotent: true,
    scope: PARTICIPANT_SCOPE,
    cli: { hidden: true },
    inputSchema: completerInputSchema,
    outputSchema: completerOutputSchema,
    handler: (input: { query?: string; conversationId?: number }, context) =>
      completeBoardChannels(input, context.conversationId),
  })
}
