import test from 'node:test'
import assert from 'node:assert/strict'
import { copyToClipboard } from '../src/conversation/clipboard.js'

test('copyToClipboard: 当 navigator.clipboard.writeText 可用时优先调用并返回 true', { timeout: 60_000 }, async () => {
  let copiedText = ''
  const originalNavigator = globalThis.navigator
  const originalDocument = globalThis.document

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text
          },
        },
      },
      configurable: true,
      writable: true,
    })

    const ok = await copyToClipboard('测试内容 123')
    assert.equal(ok, true)
    assert.equal(copiedText, '测试内容 123')
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    })
  }
})

test('copyToClipboard: 在非安全上下文（navigator.clipboard 为 undefined，如 HTTP 访问）降级到 execCommand', { timeout: 60_000 }, async () => {
  const originalNavigator = globalThis.navigator
  const originalDocument = globalThis.document

  let appendedValue = ''
  let execCommandCalled = false

  try {
    // 模拟 HTTP 非安全环境：navigator.clipboard 为 undefined
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    })

    const fakeBody = {
      appendChild: (el: any) => {
        appendedValue = el.value
      },
      removeChild: (_el: any) => {},
    }

    Object.defineProperty(globalThis, 'document', {
      value: {
        body: fakeBody,
        createElement: (tag: string) => {
          if (tag === 'textarea') {
            return {
              value: '',
              style: {},
              setAttribute: () => {},
              focus: () => {},
              select: () => {},
              setSelectionRange: () => {},
            }
          }
          return {}
        },
        execCommand: (command: string) => {
          if (command === 'copy') {
            execCommandCalled = true
            return true
          }
          return false
        },
      },
      configurable: true,
      writable: true,
    })

    const ok = await copyToClipboard('HTTP 环境降级复制')
    assert.equal(ok, true)
    assert.equal(execCommandCalled, true)
    assert.equal(appendedValue, 'HTTP 环境降级复制')
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    })
  }
})

test('copyToClipboard: 当现代 API 与降级均失败时安全返回 false 不抛异常', { timeout: 60_000 }, async () => {
  const originalNavigator = globalThis.navigator
  const originalDocument = globalThis.document

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const ok = await copyToClipboard('无环境')
    assert.equal(ok, false)
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    })
  }
})
