/**
 * builtin:swarm 动作与模型工具共享 JSON Schema 定义（全部机器描述固定纯英文）。
 */
import {
  CHANNEL_NAME_PATTERN,
  GROUP_ID_PATTERN,
  MEMBER_NAME_PATTERN,
  NODE_ID_PATTERN,
  PROFILE_ID_PATTERN,
} from './contracts.js'

const groupIdSchema: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: GROUP_ID_PATTERN,
}
const memberNameSchema: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 32,
  pattern: MEMBER_NAME_PATTERN,
}
const channelNameSchema: Record<string, unknown> = {
  type: 'string',
  minLength: 1,
  maxLength: 40,
  pattern: CHANNEL_NAME_PATTERN,
}

export const workerIdSchema: Record<string, unknown> = { type: 'integer', minimum: 1 }

export const workerIdInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workerConversationId: workerIdSchema,
    groupId: groupIdSchema,
    name: memberNameSchema,
  },
  additionalProperties: false,
}

export const dispatchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1, description: 'Initial brief task assignment for this peer role' },
    groupId: groupIdSchema,
    name: {
      ...memberNameSchema,
      description: 'Unique lowercase role name (e.g. author, verifier)',
    },
    profileId: { type: 'string', minLength: 1, maxLength: 64, pattern: PROFILE_ID_PATTERN },
    access: { type: 'string', enum: ['readwrite', 'readonly'] },
    isolation: { type: 'string', enum: ['inherit', 'worktree'] },
    forkFrom: {
      type: 'string',
      minLength: 1,
      maxLength: 32,
      description: "Optional fork source: 'coordinator' or an existing member name",
    },
    forkEntryId: { type: 'integer', minimum: 1 },
    model: { type: 'string', minLength: 1, maxLength: 200 },
    effort: { type: 'string', minLength: 1, maxLength: 32 },
    channels: { type: 'array', items: channelNameSchema },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    cwd: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1, maxLength: 64, pattern: NODE_ID_PATTERN },
  },
  required: ['prompt', 'name'],
  additionalProperties: false,
}

export const createGroupInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120, description: 'Swarm collaboration group title' },
    objective: { type: 'string', maxLength: 4000, description: 'Shared objective anchor for the squad' },
    coordinatorGuard: {
      type: 'boolean',
      description: 'Strip direct heavy coding tools on the coordinator while active (defaults to true)',
    },
    channels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: channelNameSchema,
          topic: { type: 'string', maxLength: 200 },
        },
        required: ['name'],
        additionalProperties: false,
      },
      description: 'Optional initial subchannels besides main',
    },
    conversationId: { type: 'integer', minimum: 1, description: 'Target top-level coordinator conversation ID' },
  },
  required: ['title'],
  additionalProperties: false,
}

export const updateGroupInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
    title: { type: 'string', minLength: 1, maxLength: 120 },
    objective: { type: 'string', maxLength: 4000 },
    coordinatorGuard: { type: 'boolean' },
  },
  additionalProperties: false,
}

export const manageChannelInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
    op: { type: 'string', enum: ['create', 'subscribe', 'unsubscribe', 'archive'] },
    channel: channelNameSchema,
    topic: { type: 'string', maxLength: 200 },
    member: memberNameSchema,
  },
  required: ['op', 'channel'],
  additionalProperties: false,
}

export const boardPostInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
    to: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1, maxLength: 64 },
      description: "Targets: 'coordinator', 'all' (coordinator/human only), '#<channel>', or '<memberName>'",
    },
    kind: {
      type: 'string',
      enum: ['brief', 'handoff', 'review', 'comment', 'blocker', 'done'],
    },
    body: { type: 'string', minLength: 1 },
    channel: channelNameSchema,
    wake: {
      type: 'boolean',
      description: 'Wake idle target sessions immediately (defaults to false for comment, true otherwise)',
    },
    refs: { type: 'array', items: { type: 'integer', minimum: 1 } },
  },
  required: ['to', 'kind', 'body'],
  additionalProperties: false,
}

export const boardReadInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
    channel: channelNameSchema,
    sinceSeq: { type: 'integer', minimum: 0 },
    seqs: { type: 'array', items: { type: 'integer', minimum: 1 } },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
  additionalProperties: false,
}

export const boardStatusInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
  },
  additionalProperties: false,
}

export const switchModelInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
    name: memberNameSchema,
    workerConversationId: workerIdSchema,
    model: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['model'],
  additionalProperties: false,
}

export const archiveWorkerInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workerConversationId: workerIdSchema,
    groupId: groupIdSchema,
    name: memberNameSchema,
    keepWorktree: { type: 'boolean' },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
}

export const closeGroupInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: groupIdSchema,
    keepWorktree: {
      type: 'boolean',
      description: 'Release holds and archive members while keeping modified worktree branches and unlocking coordinator bash for merging',
    },
    abortRunning: { type: 'boolean', description: 'Abort any running group members before closing' },
    summary: { type: 'string', maxLength: 2000 },
  },
  additionalProperties: false,
}

export const completerInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    conversationId: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
// 输出 Schema（14 个 ctx.action outputSchema 与 11 个 swarm_* 工具 structuredOutputSchema 同源共享）
// ---------------------------------------------------------------------------

const boardChannelSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    topic: { type: 'string' },
    archived: { type: 'boolean' },
  },
  required: ['name'],
  additionalProperties: false,
}

const retainedWorktreeSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    memberName: { type: 'string' },
    worktreeId: { type: 'string' },
    branch: { type: 'string' },
    path: { type: 'string' },
    commitsAhead: { type: 'number' },
  },
  required: ['memberName', 'worktreeId', 'branch', 'path', 'commitsAhead'],
  additionalProperties: false,
}

const groupViewInfoSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    objective: { type: 'string' },
    coordinatorConversationId: { type: 'number' },
    coordinatorGuard: { type: 'boolean' },
    status: { type: 'string', enum: ['active', 'closed'] },
    coordinatorDetached: { type: 'boolean' },
    activeWorkerCount: { type: 'number' },
    headSeq: { type: 'number' },
    channels: { type: 'array', items: boardChannelSchema },
    retainedWorktrees: { type: 'array', items: retainedWorktreeSchema },
    closeSummary: { type: 'string' },
    createdAt: { type: 'number' },
    updatedAt: { type: 'number' },
    closedAt: { type: 'number' },
  },
  required: [
    'id',
    'title',
    'coordinatorConversationId',
    'coordinatorGuard',
    'status',
    'activeWorkerCount',
    'headSeq',
    'channels',
    'createdAt',
    'updatedAt',
  ],
  additionalProperties: false,
}

const worktreeSnapshotSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    worktreeId: { type: 'string' },
    branch: { type: 'string' },
    commitsAhead: { type: 'number' },
    dirtyCount: { type: 'number' },
    changedFilesPreview: { type: 'array', items: { type: 'string' } },
  },
  required: ['worktreeId', 'dirtyCount', 'changedFilesPreview'],
  additionalProperties: false,
}

const boardPostSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    seq: { type: 'number' },
    groupId: { type: 'string' },
    channel: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'array', items: { type: 'string' } },
    resolvedTargets: { type: 'array', items: { type: 'string' } },
    wake: { type: 'boolean' },
    kind: { type: 'string', enum: ['brief', 'handoff', 'review', 'comment', 'blocker', 'done', 'stall'] },
    refs: { type: 'array', items: { type: 'number' } },
    body: { type: 'string' },
    worktreeSnapshot: worktreeSnapshotSchema,
    createdAt: { type: 'number' },
  },
  required: ['seq', 'groupId', 'channel', 'from', 'to', 'resolvedTargets', 'wake', 'kind', 'refs', 'body', 'createdAt'],
  additionalProperties: false,
}

const boardMemberViewSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    conversationId: { type: 'number' },
    profileId: { type: 'string' },
    access: { type: 'string', enum: ['readwrite', 'readonly'] },
    isolation: { type: 'string', enum: ['inherit', 'worktree'] },
    nodeId: { type: 'string' },
    cwd: { type: 'string' },
    worktreeId: { type: 'string' },
    channels: { type: 'array', items: { type: 'string' } },
    lifecycle: { type: 'string', enum: ['active', 'archived'] },
    readCursorSeq: { type: 'number' },
    pendingWakeupSeq: { type: 'number' },
    lastPostSeq: { type: 'number' },
    lastWakeTaskSeq: { type: 'number' },
    silentExitNudgeSeq: { type: 'number' },
    lastOutboundEdge: {
      type: 'object',
      properties: {
        seq: { type: 'number' },
        to: { type: 'array', items: { type: 'string' } },
        kind: { type: 'string' },
      },
      required: ['seq', 'to', 'kind'],
      additionalProperties: false,
    },
    createdAt: { type: 'number' },
    archivedAt: { type: 'number' },
    liveState: { type: 'string', enum: ['idle', 'working', 'blocked', 'error', 'missing'] },
    model: { type: 'string' },
  },
  required: [
    'name',
    'conversationId',
    'profileId',
    'access',
    'isolation',
    'nodeId',
    'cwd',
    'channels',
    'lifecycle',
    'readCursorSeq',
    'pendingWakeupSeq',
    'createdAt',
    'liveState',
  ],
  additionalProperties: false,
}

export const createGroupOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string' },
    group: groupViewInfoSchema,
  },
  required: ['groupId', 'group'],
  additionalProperties: false,
}

export const updateGroupOutputSchema = createGroupOutputSchema

export const manageChannelOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string' },
    channels: { type: 'array', items: boardChannelSchema },
  },
  required: ['groupId', 'channels'],
  additionalProperties: false,
}

export const dispatchWorkerOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workerConversationId: { type: 'number' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    worktreeId: { type: 'string' },
    postSeq: { type: 'number' },
  },
  required: ['workerConversationId', 'groupId', 'name', 'postSeq'],
  additionalProperties: false,
}

export const boardPostOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    post: boardPostSchema,
  },
  required: ['post'],
  additionalProperties: false,
}

export const boardReadOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string' },
    headSeq: { type: 'number' },
    posts: { type: 'array', items: boardPostSchema },
  },
  required: ['groupId', 'headSeq', 'posts'],
  additionalProperties: false,
}

export const boardStatusOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    group: groupViewInfoSchema,
    headline: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['normal', 'stall', 'blocker', 'unmerged', 'closed'] },
        tone: { type: 'string', enum: ['info', 'ok', 'warn', 'err'] },
        text: { type: 'string' },
        targetMember: { type: 'string' },
        refSeq: { type: 'number' },
      },
      required: ['kind', 'tone', 'text'],
      additionalProperties: false,
    },
    members: { type: 'array', items: boardMemberViewSchema },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          count: { type: 'number' },
          lastSeq: { type: 'number' },
          lastKind: { type: 'string' },
        },
        required: ['from', 'to', 'count', 'lastSeq', 'lastKind'],
        additionalProperties: false,
      },
    },
    posts: { type: 'array', items: boardPostSchema },
    activeWorkingMembers: { type: 'array', items: { type: 'string' } },
  },
  required: ['group', 'headline', 'members', 'edges', 'posts', 'activeWorkingMembers'],
  additionalProperties: false,
}

export const abortWorkerOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    aborted: { type: 'boolean' },
    workerConversationId: { type: 'number' },
    name: { type: 'string' },
  },
  required: ['aborted', 'workerConversationId', 'name'],
  additionalProperties: false,
}

export const switchModelOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workerConversationId: { type: 'number' },
    model: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['workerConversationId', 'model', 'name'],
  additionalProperties: false,
}

export const inspectWorkerOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    conversationId: { type: 'number' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    worktreeId: { type: 'string' },
    title: { type: 'string' },
    profileId: { type: 'string' },
    status: { type: 'string' },
    doing: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    completionSeq: { type: 'number' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          size: { type: 'number' },
        },
        required: ['id', 'name', 'size'],
        additionalProperties: false,
      },
    },
    recentEntries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'kind', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'conversationId',
    'groupId',
    'name',
    'title',
    'profileId',
    'status',
    'doing',
    'completionSeq',
    'artifacts',
    'recentEntries',
  ],
  additionalProperties: false,
}

export const archiveWorkerOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    archived: { type: 'boolean' },
    workerConversationId: { type: 'number' },
  },
  required: ['archived', 'workerConversationId'],
  additionalProperties: false,
}

export const closeGroupOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    closed: { type: 'boolean' },
    groupId: { type: 'string' },
    retainedWorktrees: { type: 'array', items: retainedWorktreeSchema },
  },
  required: ['closed', 'groupId', 'retainedWorktrees'],
  additionalProperties: false,
}

export const completerOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          insertText: { type: 'string' },
          hint: { type: 'string' },
          icon: { type: 'string' },
        },
        required: ['id', 'label', 'insertText'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}
