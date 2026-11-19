/**
 * Generic conversation contract: five-state machine, monotonic sequence numbers and input origins.
 * Zero business-role hardcoding — conversation responsibilities are expressed solely via profileId and tags.
 */

import type { ConversationAttachmentRef } from './artifact.js'

export type { ConversationAttachmentRef }

/** Five-state machine; any state change advances stateChangeSeq. */
export type ConversationStatus =
  | 'working' // executing reasoning, tool calls, or waiting on subagents
  | 'blocked' // waiting for human approval (pending AskDoc) or subagent terminal confirmation
  | 'done' // the current task round is complete, pending human review (unread = true)
  | 'idle' // idle and read
  | 'error' // the latest round terminated on an uncaught exception

/** Input origin, attached to every submitted `helmx.input` entry. */
export type InputOrigin = 'human' | 'agent' | 'trigger'

/** Policy for new input while the conversation is busy; the kernel defaults to steer (steering interjection) when omitted. */
export type WhenBusy = 'steer' | 'followUp' | 'reject'

/** Conversation context usage (derived display data; refreshed asynchronously by the kernel, may briefly lag real context).
 *
 * Estimation semantics align with pi agent 1.5.2's `getContextUsage`: prefer the
 * most recent valid assistant usage measurement (stopReason not aborted/error and
 * context tokens > 0) plus a character-based estimate of the messages after it;
 * after a head (pi.compaction / pi.reset) or a rewind, the invalidated anchor
 * automatically degrades to a full estimate over currently valid messages; when
 * there is no new valid usage since the latest compaction, tokens is null — the
 * real context size is unknown, and a summary character estimate is never passed
 * off as one.
 *
 * Read-only response-rate metrics do not ride along with usage: that is the policy
 * duty of optional plugins (e.g. builtin:token-speed), displayed via the
 * COMPOSER_STATUS_SLOT and a dedicated session doc. */
export interface ConversationContextUsage {
  /** Estimated tokens of the currently valid context; null = unknown (no new valid assistant usage since the compaction). */
  tokens: number | null
  /** Model context window; carried only when the resolved model has a real known window, never fabricated when unknown. */
  contextWindow?: number
  /** A compaction task is in progress (pi.live compactions non-empty, passed through; displays "compacting…"). */
  compacting?: boolean
}

/** Generic conversation summary used in conversation lists / SSE snapshots. */
export interface ConversationSummary {
  id: number
  title: string
  profileId: string
  /** The Profile expresses the role; tags are runtime/lifecycle markers declared by plugins or the user. */
  tags: string[]
  /** Derived-from conversation ID; absent on root conversations. */
  parentConversationId?: number
  /** Parent-conversation tool call ID that derived this sub-conversation or most recently resumed it (lets the frontend link the sub-conversation immediately while the subagent runs). */
  parentToolCallId?: string
  /** Conversation ownership (default 'human'; resident/background conversations created by plugins or the kernel are marked 'helmx' | 'bot'). */
  ownedBy?: 'human' | 'helmx' | 'bot'
  /** Bound compute node ID (defaults to 'local'). */
  nodeId?: string
  /** Absolute working directory path from the target node's perspective. */
  cwd: string
  /** Currently effective model 'provider/model'. */
  model: string
  /** Current thinking level (off/minimal/low/medium/high/xhigh/max); empty string means unset. */
  thinkingLevel: string
  /** Explicit thinking-level override; inherits Profile / global default when omitted. */
  thinkingLevelOverride?: string
  status: ConversationStatus
  /** Zero-token live action summary, e.g. 'bash: pnpm test' or 'thinking…'. */
  doing?: string
  /** Diagnostic summary of the current uncleared failure (e.g. 'model_error: <detail>'); appears only when
   * status === 'error', and is cleared automatically when the next round starts (run restarts). */
  lastError?: string
  /** Monotonically increasing on any state/doing/Ask change (SSE watermark and CAS validation). */
  stateChangeSeq: number
  /** Monotonically increasing at the end of each round. */
  completionSeq: number
  /**
   * Latest visible timeline entry ID (`ConversationEntry.id` as a non-negative
   * integer; `0` when the conversation has no visible entries, excluding hidden
   * `pi.system` entries). Advances strictly on every newly visible entry —
   * including `helmx.rewind`, `pi.compaction`, and `pi.reset` markers — enabling
   * reconnect `snapshot` SWR validation to skip detail fetches for unchanged conversations.
   */
  lastEntryId?: number
  /** Context usage (derived display data): refreshed asynchronously by the kernel; its changes publish
   * conversation.upsert but do not advance stateChangeSeq (the watermark belongs exclusively to the
   * state machine/doing/Ask CAS semantics). */
  contextUsage?: ConversationContextUsage
  /** Cleared only when a human explicitly focuses in Web/CLI or via PATCH; API reads never clear it. */
  unread: boolean
  pinned: boolean
  pendingAskCount: number
  createdAt: number
  updatedAt: number
}

/** Conversation creation input (`POST /api/conversations` / `ctx.host.createConversation`). */
export interface ConversationInit {
  title?: string
  profileId?: string
  tags?: string[]
  parentConversationId?: number
  /** Bound compute node ID (defaults to inheriting Profile.nodeId or 'local'). */
  nodeId?: string
  cwd?: string
  /** Currently effective model 'provider/model'; uses the Profile default when omitted. */
  model?: string
}
/** Partially update a conversation (`PATCH /api/conversations/:id`); undefined fields stay unchanged. */
export interface ConversationPatch {
  profileId?: string
  title?: string
  tags?: string[]
  nodeId?: string
  cwd?: string
  model?: string
  /** Thinking level (off/minimal/low/medium/high/xhigh/max); empty string clears the override and follows the default. */
  thinkingLevel?: string
  unread?: boolean
  pinned?: boolean
}

/** Conversation list filter (shared by the `GET /api/conversations` query and `host.listConversations`).
 * Provided fields combine with AND; absent fields are unrestricted.
 * The HTTP entry defaults to `topLevelOnly: true` when `parent`/`all` is not
 * explicitly specified (noise reduction); in-process callers (the plugin host port)
 * are unaffected by that default and still list everything. */
export interface ConversationListFilter {
  profileId?: string
  tag?: string
  status?: ConversationStatus
  /** Exact match of direct child conversations (parentConversationId === this value). */
  parentConversationId?: number
  /** Top-level conversations only (no parentConversationId); defaults to false in-process. */
  topLevelOnly?: boolean
}

/** A single conversation input (`POST /api/conversations/:id/input` request body). */
export interface ConversationInput {
  id: string
  text: string
  origin: InputOrigin
  /** Busy policy; when omitted the kernel applies the effective default steer (steering interjection) before submission. */
  whenBusy?: WhenBusy
  createdAt: number
  /** Free-form metadata already validated/redacted at the boundary; travels from CLI --meta / HTTP all the way to turn_settled. */
  meta?: Record<string, unknown>
  /** Artifact pointers attached to the input (written into the helmx.input entry after authorization checks; lightweight metadata only, no bytes). */
  attachments?: ConversationAttachmentRef[]
}

// ---------------------------------------------------------------------------
// Conversation scope (conversation-level visibility policy for plugin tools/actions)
// ---------------------------------------------------------------------------

/**
 * Conversation scope filter: AND across different fields, OR among multiple values
 * of the same field. An absent (undefined) field means that dimension is
 * unrestricted; an explicit empty array matches no conversation. This is a
 * conversation policy, not user authorization — human HTTP/CLI calls without a
 * conversationId are unrestricted.
 */
export interface ConversationScope {
  conversationIds?: number[]
  tags?: string[]
  profileIds?: string[]
  /** Filter by the conversation's current model provider; AND with the other dimensions. */
  modelProviders?: string[]
}

/** Minimal conversation shape needed for scope evaluation (any structural subset of ConversationSummary works). */
export interface ConversationScopeTarget {
  id: number
  profileId: string
  tags: string[]
  model?: string
}

/**
 * Pure function: whether a conversation falls within the scope.
 * - When scope is undefined, everything matches (unrestricted).
 * - AND across provided fields; OR among multiple values of a field.
 * - An explicit empty array = explicitly excludes everything on that dimension (no match).
 */
export function matchesConversationScope(
  scope: ConversationScope | undefined,
  conversation: ConversationScopeTarget,
): boolean {
  if (!scope) return true
  const { conversationIds, tags, profileIds, modelProviders } = scope
  if (modelProviders !== undefined && !modelProviders.includes(conversation.model?.split('/')[0] ?? '')) return false
  if (conversationIds !== undefined && !conversationIds.includes(conversation.id)) return false
  if (profileIds !== undefined && !profileIds.includes(conversation.profileId)) return false
  if (tags !== undefined) {
    let hit = false
    for (const t of tags) {
      if (conversation.tags.includes(t)) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Conversation detail and live view
// ---------------------------------------------------------------------------

/**
 * Conversation timeline entry (a cross-runtime subset of pi-durable EntryRecord).
 * `model` is the message array facing the model context (assistant text lives in
 * model, not data); `data` is the application-side JSON payload, which
 * display/bookkeeping entries may omit.
 *
 * HTTP detail projection conventions (detail pagination endpoint only; not carried
 * by SSE or single-entry endpoints):
 * - `pi.system` entries are filtered out and never sent;
 * - provider signature payloads on model message content blocks (thinkingSignature /
 *   textSignature / thoughtSignature) are stripped (only on assistant message
 *   content blocks; business objects like toolResult details are untouched);
 * - over-long plain-text toolResult messages are explicitly truncated (keeping head
 *   and tail), and the message object gains `truncated: true` / `totalChars` /
 *   `totalLines` markers for the frontend to pair precisely with each
 *   pi.tool-result; structured JSON envelopes (including the trailing footer line)
 *   and spill preview text already carrying an `[Artifact] id=` artifact entry are
 *   exempt (the artifact holds the full text). The single-entry endpoint
 *   `GET /api/conversations/:id/entries/:entryId` returns the untruncated original
 *   (only signatures stripped, and signature stripping applies only to the model
 *   payload); the database original never changes.
 */
/** Explicit truncation facts of the HTTP detail projection for plain-text tool-result previews. */
export interface ToolResultTruncation {
  truncated: true
  /** Full text character count before truncation; omitted when the server does not provide the count. */
  totalChars?: number
  /** Full text line count before truncation; omitted when the server does not provide the count. */
  totalLines?: number
}

export interface ConversationEntry {
  id: string
  kind: string
  data?: unknown
  /** Model-context messages (e.g. assistant text); absent on pure display/bookkeeping entries. */
  model?: unknown[]
  /** The execution task that appended this entry (SDK byTaskId; omitted when unattributed, e.g. scheduler context).
   * Assistant entries can be correlated with ConversationLiveGeneration.taskId
   * through it; other entries may also come from tasks such as tools — never guess
   * attribution when it is absent. */
  taskId?: number
  createdAt?: number
}

/** `GET /api/conversations/:id` response: summary + paginated timeline. */
export interface ConversationDetail extends ConversationSummary {
  entries: ConversationEntry[]
  /** Pagination cursor when earlier entries exist (the client passes it back verbatim as `?cursor=`). */
  nextCursor?: string
}

/** Per-submission result of `send --wait` / `POST /api/conversations/:id/input?wait=1`. */
export interface ConversationInputResult {
  conversationId: number
  submissionId: string
  text: string
  /** The answer entry corresponding exactly to this submission. */
  entry: ConversationEntry
}

/** Inputs currently queued in pi.inbox awaiting effect (steer takes precedence over followUp; timeline tail pills). */
export interface QueuedConversationInput {
  id: string
  submissionId: string
  text: string
  mode: 'steer' | 'followUp'
  origin: InputOrigin
  createdAt: number
  attachments?: ConversationAttachmentRef[]
}

/** Conversation live incremental view (transient SSE `conversation.live` frame payload and snapshot/resumed `conversationLives`). */
export interface ConversationLive {
  conversationId: number
  /** Accumulated snapshot of the currently streaming assistant text; the client replaces prior live text outright. */
  text: string
  /** Accumulated snapshot of the current thinking block; omitted when there is none. */
  thinking?: string
  tools: Array<{
    callId: string
    toolName: string
    input?: unknown
    status: 'running' | 'done' | 'error'
    result?: unknown
  }>
  /** Generic streaming facts needed by plugin policies (e.g. live decoding rate);
   * carried while a generation is in progress and a snapshot is projectable
   * (omitted on idle/terminal frames). The kernel only passes facts through and
   * performs no rate computation. */
  generation?: ConversationLiveGeneration
  /** Inputs currently queued in pi.inbox awaiting effect (steer takes precedence over followUp); omitted or empty when nothing is queued. */
  queuedInputs?: QueuedConversationInput[]
  updatedAt: number
}

/** Generic streaming execution facts of the current generation (the kernel only passes observed facts through, never computes rates;
 * decoding rate / TTFT / reconciliation policies are derived by consumers such as the builtin:token-speed plugin).
 *
 * Time-basis honesty: the SDK LiveState provides no wall/monotonic anchor for
 * request start, and the kernel does not fabricate one; consumers can only
 * approximate TTFT using "the frame time when the generation was first observed"
 * (constrained by both live throttling and partial-commit throttling), and the
 * presentation layer must label it as such. */
export interface ConversationLiveGeneration {
  /** The generation task this generation belongs to (SDK live.run.taskId; each tool
   * round's handOver swaps in a new task, retries within the same task do not).
   * Same source as entry.taskId — the join key precisely linking the streaming
   * snapshot with the finally persisted result; the kernel only passes it through,
   * never fabricates it. */
  taskId: number
  /** Attempt ordinal within the same generation task (increments on retry; resets to 1 for each new task per tool round). */
  attempt: number
  /** Current accumulated assistant message snapshot (restricted projection; omitted while the message has no content yet). */
  message?: ConversationLiveMessage
}

/** Restricted JSON-safe projection of the streaming assistant message (generation content facts only).
 *
 * - text / thinking blocks: string snapshots;
 * - toolCall blocks: name and arguments (partial is the in-progress JSON value;
 *   arguments are model-generated tokens and rate policies must not undercount them);
 * - usage: only the provider-reported cumulative figure (omitted when not reported)
 *   — never substituted with character estimates;
 * - no fields beyond content and usage are passed through (no provider request
 *   private data leaks; content shares the same source and kind as the existing
 *   text/thinking/tools fields). */
export interface ConversationLiveMessage {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'toolCall'; name: string; arguments?: unknown }
  >
  /** Provider-reported cumulative output tokens (partial.usage.output; carried only when a positive finite number). */
  usage?: { output: number }
}

/** Turn terminal outcome; the turn_settled hook uniformly covers all three. */
export type TurnOutcome = 'completed' | 'failed' | 'aborted'

/** Turn settlement payload (shared by the turn_settled hook and the turn.settled event). */
export interface TurnSettledPayload {
  conversation: ConversationSummary
  inputs: ConversationInput[]
  outcome: TurnOutcome
  /** Error summary when outcome is failed. */
  error?: string
  settledAt: number
}
