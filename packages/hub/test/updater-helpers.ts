/** Shared fixtures between the updater and changelog route tests. */
import type { HubActivityCounts } from '@helmx/protocol';

export function emptyCounts(): HubActivityCounts {
  return { activeConversations: 0, activeCompactions: 0, queuedConversations: 0, settlingConversations: 0 };
}

export function makeApply(body?: Record<string, unknown>): Request {
  return new Request('http://x/api/hub-update/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}
