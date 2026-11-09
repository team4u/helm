import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { parseArtifactUrl, markdownUrlTransform } from '../src/conversation/artifact-link.js'
import { MarkdownView } from '../src/conversation/MarkdownView.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'

;(globalThis as Record<string, unknown>).React = React

describe('artifact-link 纯函数解析与 URL 转换', { timeout: 60_000 }, () => {
  test('parseArtifactUrl：识别 artifact:<id> 合法形态', () => {
    assert.equal(parseArtifactUrl('artifact:art_123'), 'art_123')
    assert.equal(parseArtifactUrl('artifact:8f806786-2425-4dc5-aad0-98f55015384b'), '8f806786-2425-4dc5-aad0-98f55015384b')
    assert.equal(parseArtifactUrl('artifact:file.tar.gz'), 'file.tar.gz')
    assert.equal(parseArtifactUrl('artifact:report:v1_final-2'), 'report:v1_final-2')
    assert.equal(parseArtifactUrl('  artifact:trimmed-id  '), 'trimmed-id')
  })

  test('parseArtifactUrl：识别 /api/artifacts/<id>/content(?...)? 接口路径', () => {
    assert.equal(parseArtifactUrl('/api/artifacts/art-456/content'), 'art-456')
    assert.equal(parseArtifactUrl('/api/artifacts/art-456/content?inline=1'), 'art-456')
    assert.equal(parseArtifactUrl('/api/artifacts/8f806786-2425-4dc5-aad0-98f55015384b/content?download=1&token=xyz'), '8f806786-2425-4dc5-aad0-98f55015384b')
    assert.equal(parseArtifactUrl('  /api/artifacts/art-789/content?foo=bar  '), 'art-789')
  })

  test('parseArtifactUrl：非法或不匹配 URL 返回 null', () => {
    assert.equal(parseArtifactUrl(undefined), null)
    assert.equal(parseArtifactUrl(''), null)
    assert.equal(parseArtifactUrl('   '), null)
    assert.equal(parseArtifactUrl('artifact:'), null)
    assert.equal(parseArtifactUrl('artifact:/bad-path'), null)
    assert.equal(parseArtifactUrl('artifact:bad/path/id'), null)
    assert.equal(parseArtifactUrl('artifact:bad?query=1'), null)
    assert.equal(parseArtifactUrl('/api/artifacts//content'), null)
    assert.equal(parseArtifactUrl('/api/artifacts/content'), null)
    assert.equal(parseArtifactUrl('https://example.com/api/artifacts/123/content'), null)
    assert.equal(parseArtifactUrl('https://github.com'), null)
  })

  test('markdownUrlTransform：放行产物链接并拦截危险协议', () => {
    assert.equal(markdownUrlTransform('artifact:art-123'), 'artifact:art-123')
    assert.equal(markdownUrlTransform('/api/artifacts/art-123/content?inline=1'), '/api/artifacts/art-123/content?inline=1')
    assert.equal(markdownUrlTransform('https://example.com'), 'https://example.com')
    // 拦截 javascript: 等伪协议（defaultUrlTransform 行为）
    assert.equal(markdownUrlTransform('javascript:alert(1)'), '')
    assert.equal(markdownUrlTransform('vbscript:msgbox(1)'), '')
  })
})

describe('MarkdownView 产物内联渲染', { timeout: 60_000 }, () => {
  function makeMockStore(activeModalFn?: (modal: unknown) => void): HelmStoreValue {
    return {
      theme: 'dark',
      themePreference: 'system',
      activeModal: null,
      setActiveModal: activeModalFn ?? (() => {}),
      conversationArtifacts: {},
      loadConversationArtifacts: async () => {},
      pushNotice: () => {},
      openTarget: () => {},
    } as unknown as HelmStoreValue
  }

  test('MarkdownView：[文件名](artifact:<id>) 渲染为 attachment-chip 按钮', () => {
    const store = makeMockStore()
    const html = renderToString(
      React.createElement(
        HelmStoreContext.Provider,
        { value: store },
        React.createElement(MarkdownView, {
          text: '请查看输出：[数据报告.csv](artifact:art-csv-101)',
          conversationId: 1,
        }),
      ),
    )
    assert.match(html, /<button[^>]*class="attachment-chip"[^>]*title="点击预览产物"/)
    assert.match(html, /数据报告\.csv/)
    assert.doesNotMatch(html, /<a href="artifact:/)
  })

  test('MarkdownView：普通外链仍渲染为 <a> 标签', () => {
    const store = makeMockStore()
    const html = renderToString(
      React.createElement(
        HelmStoreContext.Provider,
        { value: store },
        React.createElement(MarkdownView, {
          text: '访问官网：[Helm Docs](https://helm.dev)',
          conversationId: 1,
        }),
      ),
    )
    assert.match(html, /<a href="https:\/\/helm\.dev"/)
    assert.match(html, /Helm Docs/)
    assert.doesNotMatch(html, /attachment-chip/)
  })

  test('MarkdownView：![图片标题](artifact:<id>) 渲染产物内联组件骨架', () => {
    const store = makeMockStore()
    const html = renderToString(
      React.createElement(
        HelmStoreContext.Provider,
        { value: store },
        React.createElement(MarkdownView, {
          text: '流程图预览：\n\n![架构图](artifact:arch-img-202)',
          conversationId: 2,
        }),
      ),
    )
    // 服务端 SSR 阶段 loading 态直出 attachment-chip 加载骨架
    assert.match(html, /class="attachment-chip"/)
    assert.match(html, /架构图/)
  })
})
