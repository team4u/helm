/**
 * builtin:swarm 动作与模型工具共享 JSON Schema 定义（全部机器描述固定纯英文）。
 */
export const workerIdSchema: Record<string, unknown> = { type: 'integer', minimum: 1 }

export const workerIdInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workerConversationId: workerIdSchema,
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 32 },
  },
  additionalProperties: false,
}

export const dispatchInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1, description: 'Initial brief task assignment for this peer role' },
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 32, description: 'Unique lowercase role name (e.g. author, verifier)' },
    profileId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s/\\\\]+$' },
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
    channels: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 } },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    cwd: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s/\\\\]+$' },
  },
  required: ['prompt', 'name'],
  additionalProperties: false,
}

export const createGroupInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120, description: 'Swarm collaboration group title' },
    objective: { type: 'string', maxLength: 4000, description: 'Shared objective anchor for the squad' },
    channels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 40 },
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
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    objective: { type: 'string', maxLength: 4000 },
  },
  additionalProperties: false,
}

export const manageChannelInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    op: { type: 'string', enum: ['create', 'subscribe', 'unsubscribe', 'archive'] },
    channel: { type: 'string', minLength: 1, maxLength: 40 },
    topic: { type: 'string', maxLength: 200 },
    member: { type: 'string', minLength: 1, maxLength: 32 },
  },
  required: ['op', 'channel'],
  additionalProperties: false,
}

export const boardPostInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
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
    channel: { type: 'string', minLength: 1, maxLength: 40 },
    wake: {
      type: 'boolean',
      description: 'Wake idle target sessions immediately (defaults to false for comment, true otherwise)',
    },
    refs: { type: 'array', items: { type: 'integer', minimum: 1 } },
    from: { type: 'string', minLength: 1, maxLength: 32 },
  },
  required: ['to', 'kind', 'body'],
  additionalProperties: false,
}

export const boardReadInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    channel: { type: 'string', minLength: 1, maxLength: 40 },
    sinceSeq: { type: 'integer', minimum: 0 },
    seqs: { type: 'array', items: { type: 'integer', minimum: 1 } },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
  },
  additionalProperties: false,
}

export const boardStatusInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
  },
  additionalProperties: false,
}

export const switchModelInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 32 },
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
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: 32 },
    keepWorktree: { type: 'boolean' },
    force: { type: 'boolean' },
  },
  additionalProperties: false,
}

export const closeGroupInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    groupId: { type: 'string', minLength: 1, maxLength: 64 },
    keepWorktree: {
      type: 'boolean',
      description: 'Release holds and archive members while preserving modified worktree branches in retainedWorktrees for merging',
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
