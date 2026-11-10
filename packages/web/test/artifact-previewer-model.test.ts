/**
 * artifact.previewer 匹配纯函数测试：
 * - MIME 精确 / type/* 通配 / 大小写 / 空 MIME；
 * - 多段后缀（.tar.gz）、名称未知不猜；
 * - mime/extensions OR、都缺省接管全部；
 * - scope 过滤（无会话上下文不可泛命中）+ priority 降序稳定排序；
 * - 文本解码判定与 1MiB 上限（超限 null 不截断伪装）。
 */
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ArtifactPreviewerSpec, ConversationSummary, PluginUiContribution } from '@helm/protocol'
import {
  collectArtifactPreviewers,
  matchesExtension,
  matchesMimeType,
  previewerMatchesArtifact,
  type ArtifactPreviewerContribution,
} from '../src/conversation/artifact-preview-model.js'
import { decodePreviewText, MAX_PREVIEW_TEXT_BYTES, shouldDecodeText } from '../src/conversation/artifact-preview-text.js'

const contrib = (
  pluginId: string,
  spec: Partial<ArtifactPreviewerSpec> & { id: string; label: string },
): ArtifactPreviewerContribution => ({ pluginId, spec: spec as ArtifactPreviewerSpec })

const require_types = (): { groupUiContributions: (c: PluginUiContribution[]) => ReturnType<typeof import('../src/lib/types.js').groupUiContributions> } =>
  createRequire(import.meta.url)('../src/lib/types.js') as never

const conversation = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: 7,
  title: '测试会话',
  profileId: 'assistant',
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
}) as ConversationSummary

test('matchesMimeType：精确值与 type/* 通配（大小写不敏感）', { timeout: 60_000 }, () => {
  const mimes = ['application/json', 'image/*']
  assert.equal(matchesMimeType(mimes, 'application/json'), true, '精确命中')
  assert.equal(matchesMimeType(mimes, 'image/png'), true, 'type/* 通配命中')
  assert.equal(matchesMimeType(mimes, 'IMAGE/PNG'), true, '实际值大小写不敏感')
  assert.equal(matchesMimeType(['IMAGE/*'], 'image/png'), true, '声明值大小写不敏感')
  assert.equal(matchesMimeType(mimes, 'application/xml'), false, '不同 subtype 不命中')
  assert.equal(matchesMimeType(mimes, ''), false, '空 MIME 不命中')
  assert.equal(matchesMimeType(mimes, 'text/*'), false, 'text/* 不是通配声明')
  assert.equal(matchesMimeType(undefined, 'application/json'), false, '未声明不命中')
  assert.equal(matchesMimeType([], 'application/json'), false, '空数组不命中')
  assert.equal(matchesMimeType(['', '  '], 'application/json'), false, '全空白声明不命中')
  assert.equal(matchesMimeType(['  Application/JSON  '], 'application/json'), true, '首尾空白容忍')
})

test('matchesExtension：多段后缀与名称未知不猜', { timeout: 60_000 }, () => {
  assert.equal(matchesExtension(['.tar.gz'], 'data.tar.gz'), true, '多段后缀命中')
  assert.equal(matchesExtension(['.gz'], 'data.tar.gz'), true, '单段后缀命中末段')
  assert.equal(matchesExtension(['.Tar.GZ'], 'data.tar.gz'), true, '声明大小写不敏感')
  assert.equal(matchesExtension(['.JSON'], 'report.json'), true, '实际名称大小写不敏感')
  assert.equal(matchesExtension(['.tar.gz'], 'data.tgz'), false, 'tgz 不命中 tar.gz')
  assert.equal(matchesExtension(['.json'], 'data.json5'), false, '后缀必须右端全等')
  assert.equal(matchesExtension(['.json'], undefined), false, '名称未知不命中')
  assert.equal(matchesExtension(['.json'], '  '), false, '空白名称不命中')
  assert.equal(matchesExtension(undefined, 'a.json'), false, '未声明不命中')
  assert.equal(matchesExtension([], 'a.json'), false, '空数组不命中')
  assert.equal(matchesExtension(['json'], 'a.json'), true, '宽容处理漏点号声明（endsWith 语义不变）')
})

test('previewerMatchesArtifact：mime/extensions OR，都缺省接管全部', { timeout: 60_000 }, () => {
  const both = contrib('p', { id: 'x', label: 'L', mimeTypes: ['text/csv'], extensions: ['.md'] })
  assert.equal(previewerMatchesArtifact(both.spec, { name: 'a.md', mimeType: 'text/plain' }), true, '后缀命中')
  assert.equal(previewerMatchesArtifact(both.spec, { name: 'a.csv', mimeType: 'text/csv' }), true, 'MIME 命中')
  assert.equal(previewerMatchesArtifact(both.spec, { name: 'a.txt', mimeType: 'text/plain' }), false, '两者皆不命中')

  const wildcard = contrib('p', { id: 'all', label: '全部' })
  assert.equal(previewerMatchesArtifact(wildcard.spec, { name: undefined, mimeType: '' }), true, '未声明匹配维度 = 接管全部')

  const mimeOnly = contrib('p', { id: 'm', label: 'L', mimeTypes: ['application/pdf'] })
  assert.equal(previewerMatchesArtifact(mimeOnly.spec, { name: 'x.pdf', mimeType: '' }), false, '仅 MIME 声明不做后缀推断')
})

test('collectArtifactPreviewers：priority 降序稳定排序', { timeout: 60_000 }, () => {
  const items = [
    contrib('p1', { id: 'a', label: 'A' }),                                            // priority 0
    contrib('p2', { id: 'b', label: 'B', priority: 10, extensions: ['.md'] }),        // 高优先
    contrib('p3', { id: 'c', label: 'C', priority: 10, extensions: ['.md'] }),        // 同分保持贡献顺序
    contrib('p4', { id: 'd', label: 'D', priority: 5, extensions: ['.md'] }),
  ]
  const ranked = collectArtifactPreviewers(items, { name: 'x.md', mimeType: 'text/markdown' }, undefined)
  assert.deepEqual(ranked.map((r) => r.spec.id), ['b', 'c', 'd', 'a'], 'priority 降序 -> 贡献顺序稳定')
})

test('collectArtifactPreviewers：scope 过滤与无会话上下文语义', { timeout: 60_000 }, () => {
  const scoped = contrib('p1', { id: 'scoped', label: 'S', scope: { tags: ['worker'] }, extensions: ['.log'] })
  const global = contrib('p2', { id: 'global', label: 'G', extensions: ['.log'] })

  const noCtx = collectArtifactPreviewers([scoped, global], { name: 'a.log', mimeType: 'text/plain' }, undefined)
  assert.deepEqual(noCtx.map((i) => i.spec.id), ['global'], '无会话上下文：带 scope 贡献不命中（不可泛命中）')

  const hit = collectArtifactPreviewers([scoped, global], { name: 'a.log', mimeType: 'text/plain' }, conversation({ tags: ['worker'] }))
  assert.deepEqual(hit.map((i) => i.spec.id), ['scoped', 'global'], '会话元数据已加载且命中 scope')

  const miss = collectArtifactPreviewers([scoped, global], { name: 'a.log', mimeType: 'text/plain' }, conversation({ tags: ['other'] }))
  assert.deepEqual(miss.map((i) => i.spec.id), ['global'], 'scope 不命中被过滤')

  const byProfile = collectArtifactPreviewers(
    [contrib('p', { id: 's', label: 'S', scope: { profileIds: ['watchdog'] } })],
    { name: 'a.log', mimeType: 'text/plain' },
    conversation({ profileId: 'watchdog' }),
  )
  assert.equal(byProfile.length, 1, 'profileIds scope 命中')
})

test('shouldDecodeText：MIME 未知时按已知文本后缀、名称未知不猜', { timeout: 60_000 }, () => {
  assert.equal(shouldDecodeText(undefined, 'application/json'), true, '文本类 MIME 解码')
  assert.equal(shouldDecodeText(undefined, 'image/png'), false, '二进制 MIME 不解码')
  assert.equal(shouldDecodeText(undefined, ''), false, 'MIME 未知且无元数据不猜')
  assert.equal(shouldDecodeText({ id: 'a', name: 'notes.md', mimeType: '', size: 3, createdAt: '', conversationId: 1 } as never, ''), true, 'MIME 未知按文本后缀解码')
  assert.equal(shouldDecodeText({ id: 'a', name: 'blob.bin', mimeType: '', size: 3, createdAt: '', conversationId: 1 } as never, ''), false, '未知后缀不解码')
  assert.equal(shouldDecodeText({ id: 'a', name: undefined, mimeType: '', size: 3, createdAt: '', conversationId: 1 } as never, ''), false, '名称未知不猜')
})

test('decodePreviewText：超过 1MiB 上限返回 null（不截断伪装全文）', { timeout: 60_000 }, async () => {
  const small = new Blob(['{"ok":true}'], { type: 'application/json' })
  assert.equal(await decodePreviewText(small), '{"ok":true}')
  assert.equal(small.size <= MAX_PREVIEW_TEXT_BYTES, true)

  const big = new Blob([new Uint8Array(MAX_PREVIEW_TEXT_BYTES + 1)], { type: 'application/json' })
  assert.equal(big.size, MAX_PREVIEW_TEXT_BYTES + 1)
  assert.equal(await decodePreviewText(big), null, '超限显式 null，绝不截断部分文本冒充全文')
})

test('groupUiContributions：artifact.previewer 贡献进入 artifactPreviewers 分组', { timeout: 60_000 }, () => {
  const { groupUiContributions } = require_types()
  const contribution: PluginUiContribution = {
    pluginId: 'demo:plugin',
    surface: 'artifact.previewer',
    spec: { id: 'csv', label: 'CSV 表格', mimeTypes: ['text/csv'], extensions: ['.csv'] },
  }
  const grouped = groupUiContributions([contribution])
  assert.equal(grouped.artifactPreviewers.length, 1)
  assert.equal(grouped.artifactPreviewers[0]!.pluginId, 'demo:plugin')
  assert.equal(grouped.artifactPreviewers[0]!.spec.label, 'CSV 表格')
})
