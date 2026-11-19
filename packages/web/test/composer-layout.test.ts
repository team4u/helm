import test from 'node:test'
import assert from 'node:assert/strict'
import { canConfigureSessionEnv, envDraftError, envDraftOnNodeChange, envDraftUnchanged, formatEnvSubtitle } from '../src/conversation/composer-model.js'

const e = (kind: string) => ({ kind })

test('canConfigureSessionEnv: configurable only for empty conversations or after a handoff-less /reset with no new messages', { timeout: 60_000 }, () => {
  // An empty conversation (idle, no entries) is allowed.
  assert.equal(canConfigureSessionEnv([], 'idle'), true)
  // Not allowed while details are still loading (no flapping config UI in the gap).
  assert.equal(canConfigureSessionEnv(undefined, 'idle'), false)
  // Any substantive conversational entry locks it (real SDK kinds use hyphens; legacy underscore spellings stay accepted).
  assert.equal(canConfigureSessionEnv([e('helmx.input')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.user')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.assistant')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.tool-call')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.tool-result')], 'idle'), false)
  assert.equal(canConfigureSessionEnv([e('pi.tool_call')], 'idle'), false)
  // Compaction is substantive context: it must not become an unlock path.
  assert.equal(canConfigureSessionEnv([e('pi.reset'), e('pi.compaction')], 'idle'), false)
  // Working / blocked always forbids configuration.
  assert.equal(canConfigureSessionEnv([], 'working'), false)
  assert.equal(canConfigureSessionEnv([], 'blocked'), false)
  // History ending with pi.reset (no handoff) and no new messages after -> configurable again.
  assert.equal(
    canConfigureSessionEnv([e('helmx.input'), e('pi.assistant'), e('pi.reset')], 'idle'),
    true,
  )
  // A new helmx.input after pi.reset -> locked.
  assert.equal(
    canConfigureSessionEnv([e('helmx.input'), e('pi.reset'), e('helmx.input')], 'idle'),
    false,
  )
  // Reset with handoff: a non-empty data.handoff string keeps it locked (the new context inherits the old environment narrative).
  assert.equal(
    canConfigureSessionEnv([{ kind: 'pi.reset', data: { handoff: '继续之前的任务环境' } }], 'idle'),
    false,
  )
  // An empty-string data.handoff (plain reset) does not lock.
  assert.equal(
    canConfigureSessionEnv([{ kind: 'pi.reset', data: { handoff: '' } }], 'idle'),
    true,
  )
  // The SDK may also write the handoff into model ([UserMessage] text; see the pi-durable README/entries.d.ts).
  assert.equal(
    canConfigureSessionEnv(
      [{ kind: 'pi.reset', data: null, model: [{ role: 'user', content: 'Handoff summary：节点 gpu-box' }] }],
      'idle',
    ),
    false,
  )
  // Segmented text inside model also counts as a handoff.
  assert.equal(
    canConfigureSessionEnv(
      [{ kind: 'pi.reset', model: [{ role: 'user', content: [{ type: 'text', text: 'Handoff summary' }] }] }],
      'idle',
    ),
    false,
  )
  // A model with a non-user role does not constitute a handoff.
  assert.equal(
    canConfigureSessionEnv([{ kind: 'pi.reset', model: [{ role: 'assistant', content: 'x' }] }], 'idle'),
    true,
  )
  // Non-conversational entries (e.g. helmx.notice) do not affect the empty-state verdict.
  assert.equal(canConfigureSessionEnv([e('helmx.notice')], 'idle'), true)
})

test('starting-environment draft: switching nodes never keeps the old cwd; validation rejects empty/relative paths', { timeout: 60_000 }, () => {
  // Node unchanged: the cwd draft is kept.
  assert.deepEqual(
    envDraftOnNodeChange({ nodeId: 'local', cwd: '/root/code/helm' }, 'local'),
    { nodeId: 'local', cwd: '/root/code/helm' },
  )
  // Switching nodes: the cwd draft is cleared; old-node paths are never inherited.
  assert.deepEqual(
    envDraftOnNodeChange({ nodeId: 'local', cwd: '/root/code/helm' }, 'gpu-box'),
    { nodeId: 'gpu-box', cwd: '' },
  )
  // Draft validation: empty and relative paths rejected; POSIX and Windows absolute paths pass.
  assert.match(envDraftError({ nodeId: 'local', cwd: '' }) ?? '', /Enter the working directory/)
  assert.match(envDraftError({ nodeId: 'local', cwd: '  ' }) ?? '', /Enter the working directory/)
  assert.match(envDraftError({ nodeId: 'local', cwd: 'relative/path' }) ?? '', /absolute path/)
  assert.equal(envDraftError({ nodeId: 'local', cwd: '/root/code/helm' }), null)
  assert.equal(envDraftError({ nodeId: 'win-node', cwd: 'C:\\workspace\\helmx' }), null)
  assert.equal(envDraftError({ nodeId: 'win-node', cwd: 'C:/workspace/helmx' }), null)
  // Compared against the current coordinate: an absent nodeId counts as local.
  assert.equal(envDraftUnchanged({ nodeId: 'local', cwd: '/a' }, undefined, '/a'), true)
  assert.equal(envDraftUnchanged({ nodeId: 'local', cwd: '/a' }, 'local', '/a'), true)
  assert.equal(envDraftUnchanged({ nodeId: 'gpu-box', cwd: '/a' }, 'local', '/a'), false)
  assert.equal(envDraftUnchanged({ nodeId: 'local', cwd: '/b' }, 'local', '/a'), false)
})

test('formatEnvSubtitle: local omits @local, remote carries the @node prefix, tooltip keeps full info', { timeout: 60_000 }, () => {
  // Local: omits @local, shows profileId · the last two cwd segments.
  assert.deepEqual(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'local', cwd: '/root/code/helm' }), {
    text: 'assistant · code/helm',
    tooltip: 'Agent: assistant · Node: local · Working directory: /root/code/helm',
  })
  // An absent nodeId counts as local.
  assert.equal(formatEnvSubtitle({ profileId: 'assistant', cwd: '/root/code/helm' }).text, 'assistant · code/helm')
  // Remote node: @gpu-box:tail.
  assert.deepEqual(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'gpu-box', cwd: '/home/user/code/helmx' }), {
    text: 'assistant · @gpu-box:code/helmx',
    tooltip: 'Agent: assistant · Node: gpu-box · Working directory: /home/user/code/helmx',
  })
  // Empty cwd: local shows only profileId; remote shows @node.
  assert.equal(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'local', cwd: '' }).text, 'assistant')
  assert.equal(formatEnvSubtitle({ profileId: 'assistant', nodeId: 'gpu-box', cwd: '' }).text, 'assistant · @gpu-box')
  // The trailing segment count is configurable.
  assert.equal(formatEnvSubtitle({ profileId: 'p', cwd: '/a/b/c/d', segments: 3 }).text, 'p · b/c/d')
  // The tooltip of an empty cwd shows (not set).
  assert.equal(
    formatEnvSubtitle({ profileId: 'p', cwd: '' }).tooltip,
    'Agent: p · Node: local · Working directory: (not set)',
  )
})

test('formatEnvSubtitle: Windows backslashes and root paths; compact mode keeps only the remote node identity', { timeout: 60_000 }, () => {
  // Windows backslashes split into segments, still taking the last two.
  assert.equal(
    formatEnvSubtitle({ profileId: 'p', nodeId: 'win-node', cwd: 'C:\\Users\\dev\\work\\helmx' }).text,
    'p · @win-node:work/helmx',
  )
  // Mixed separators.
  assert.equal(formatEnvSubtitle({ profileId: 'p', cwd: 'C:\\a/b/c' }).text, 'p · b/c')
  // Root paths lose no segment: '/' stays as one; 'C:\\' keeps the drive segment after splitting (cwd shortening affects display only; the tooltip is always full).
  assert.equal(formatEnvSubtitle({ profileId: 'p', cwd: '/' }).text, 'p · /')
  assert.equal(formatEnvSubtitle({ profileId: 'p', nodeId: 'win', cwd: 'C:\\' }).text, 'p · @win:C:')
  // Compact: remote shows only @node, local yields an empty string (callers skip rendering); the tooltip stays full.
  assert.deepEqual(formatEnvSubtitle({ profileId: 'p', nodeId: 'gpu-box', cwd: '/x/y', compact: true }), {
    text: '@gpu-box',
    tooltip: 'Agent: p · Node: gpu-box · Working directory: /x/y',
  })
  assert.equal(formatEnvSubtitle({ profileId: 'p', nodeId: 'local', cwd: '/x/y', compact: true }).text, '')
})
