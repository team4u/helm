import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary } from '@helm/protocol'
import { buildAncestorChain, collectSubtreeIds, MAX_ANCESTRY_DEPTH } from '../src/conversation/ancestry-model.js'

function summary(id: number, parentConversationId?: number): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id,
    updatedAt: id,
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
  }
}

test('buildAncestorChain 返回根在前的任意深度祖先链', { timeout: 60_000 }, () => {
  const conversations = [summary(1), summary(11, 1), summary(111, 11), summary(1111, 111)]
  assert.deepEqual(buildAncestorChain(conversations, 1111), [1, 11, 111])
  assert.deepEqual(buildAncestorChain(conversations, 11), [1])
  assert.deepEqual(buildAncestorChain(conversations, 1), [], '根会话无祖先链')
})

test('buildAncestorChain 对环与缺失摘要安全截断', { timeout: 60_000 }, () => {
  // 环：2 → 1 → 2（脏数据）——访问过即停，不递归失控（环无真根，按到达顺序根在前）
  const cyclic = [summary(1, 2), summary(2, 1), summary(3, 2)]
  assert.deepEqual(buildAncestorChain(cyclic, 3), [1, 2])
  // 父摘要缺失：仍保留该级 ID，链到未知处为止
  const missing = [summary(5, 99)]
  assert.deepEqual(buildAncestorChain(missing, 5), [99])
  // 超深链按 MAX_ANCESTRY_DEPTH 截断
  const deep: ConversationSummary[] = [summary(0)]
  for (let i = 1; i <= MAX_ANCESTRY_DEPTH + 10; i++) deep.push(summary(i, i - 1))
  const chain = buildAncestorChain(deep, MAX_ANCESTRY_DEPTH + 10)
  assert.equal(chain.length, MAX_ANCESTRY_DEPTH)
  assert.equal(chain[0], 10, '超深截断时保留最靠近根的 MAX_ANCESTRY_DEPTH 级（根在前）')
  assert.equal(chain[chain.length - 1], MAX_ANCESTRY_DEPTH + 9, '链尾是最近祖先')
})

test('collectSubtreeIds 收集含自身的全部后代且防环', { timeout: 60_000 }, () => {
  const conversations = [summary(1), summary(11, 1), summary(12, 1), summary(111, 11), summary(9)]
  assert.deepEqual([...collectSubtreeIds(conversations, 1)].sort((a, b) => a - b), [1, 11, 12, 111])
  assert.deepEqual([...collectSubtreeIds(conversations, 11)], [11, 111])
  assert.deepEqual([...collectSubtreeIds(conversations, 9)], [9])
  // 环：1 → 11 → 1，子树遍历不得死循环
  const cyclic = [summary(1, 11), summary(11, 1), summary(111, 11)]
  assert.deepEqual([...collectSubtreeIds(cyclic, 1)].sort((a, b) => a - b), [1, 11, 111])
})
