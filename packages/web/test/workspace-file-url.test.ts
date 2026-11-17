import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { isDisallowedFileUrl, parseWorkspaceFileRef } from '../src/conversation/workspace-file-url.js'

describe('workspace-file-url: isDisallowedFileUrl', { timeout: 60_000 }, () => {
  test('recognizes file: scheme case-insensitively with optional whitespace', { timeout: 60_000 }, () => {
    assert.equal(isDisallowedFileUrl('file:///etc/passwd'), true)
    assert.equal(isDisallowedFileUrl('  FILE:///C:/secret.txt  '), true)
    assert.equal(isDisallowedFileUrl('file:relative.txt'), true)
    assert.equal(isDisallowedFileUrl('https://example.com/file://foo'), false)
    assert.equal(isDisallowedFileUrl('docs/file.md'), false)
    assert.equal(isDisallowedFileUrl(undefined), false)
  })
})

describe('workspace-file-url: parseWorkspaceFileRef', { timeout: 60_000 }, () => {
  test('parses relative workspace paths and line fragments', { timeout: 60_000 }, () => {
    assert.deepEqual(parseWorkspaceFileRef('README.md'), { path: 'README.md' })
    assert.deepEqual(parseWorkspaceFileRef('./docs/guide.md'), { path: 'docs/guide.md' })
    assert.deepEqual(parseWorkspaceFileRef('docs/guide.md#install'), { path: 'docs/guide.md' })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#L12'), { path: 'src/app.ts', startLine: 12 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#L12-L34'), { path: 'src/app.ts', startLine: 12, endLine: 34 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#l5-10'), { path: 'src/app.ts', startLine: 5, endLine: 10 })
    assert.deepEqual(parseWorkspaceFileRef('docs/my%20notes.md#L3'), { path: 'docs/my notes.md', startLine: 3 })
  })

  test('resolves relative to workspaceBaseDir and blocks root escapes', { timeout: 60_000 }, () => {
    assert.deepEqual(
      parseWorkspaceFileRef('./images/arch.png', { workspaceBaseDir: 'docs/sub' }),
      { path: 'docs/sub/images/arch.png' },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('../src/index.ts#L8', { workspaceBaseDir: 'docs' }),
      { path: 'src/index.ts', startLine: 8 },
    )
    assert.equal(parseWorkspaceFileRef('../../etc/passwd', { workspaceBaseDir: 'docs' }), null)
    assert.equal(parseWorkspaceFileRef('../outside.md'), null)
    assert.equal(parseWorkspaceFileRef('.'), null)
    assert.equal(parseWorkspaceFileRef('./'), null)
    assert.equal(parseWorkspaceFileRef('..', { workspaceBaseDir: 'docs' }), null)
    assert.equal(parseWorkspaceFileRef('docs/'), null)
  })

  test('handles POSIX and Windows file:// URLs strictly inside conversationCwd', { timeout: 60_000 }, () => {
    assert.equal(parseWorkspaceFileRef('file:///repo/src/a.ts'), null)
    assert.equal(parseWorkspaceFileRef('file:///etc/passwd', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('file:///repo-other/a.ts', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('file:///repo', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('file:///repo/', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('file://remote-host/repo/a.ts', { conversationCwd: '/repo' }), null)

    assert.deepEqual(
      parseWorkspaceFileRef('file:///repo/src/a.ts#L10-L20', { conversationCwd: '/repo/' }),
      { path: 'src/a.ts', startLine: 10, endLine: 20 },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('file://localhost/repo/my%20file.md#section', { conversationCwd: '/repo' }),
      { path: 'my file.md' },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('FILE:///C:/Users/Alice/Repo/src/App.tsx#L4', { conversationCwd: 'c:\\users\\alice\\repo' }),
      { path: 'src/App.tsx', startLine: 4 },
    )
    assert.equal(
      parseWorkspaceFileRef('file:///D:/Users/Alice/Repo/src/App.tsx', { conversationCwd: 'C:\\Users\\Alice\\Repo' }),
      null,
    )
  })

  test('rejects anchors, protocol-relative, API/root paths, query strings, schemes, and bare web hosts', { timeout: 60_000 }, () => {
    const rejected = [
      undefined,
      '',
      '   ',
      '#heading',
      '//cdn.example.com/a.png',
      '/api/conversations/1/files/content?path=a.ts',
      '/etc/passwd',
      'docs/guide.md?raw=1',
      'https://github.com/foo/bar',
      'http://localhost:3000/a',
      'mailto:a@b.com',
      'javascript:alert(1)',
      'artifact:art-123',
      'localhost:3000/foo',
      'localhost/foo',
      '127.0.0.1/foo',
      '127.0.0.1:8080/bar',
      'github.com/foo/bar',
      'EXAMPLE.ORG:8443/docs',
      'docs.io/guide',
      'app.dev/index',
    ]
    for (const input of rejected) {
      assert.equal(parseWorkspaceFileRef(input, { conversationCwd: '/repo' }), null, `should reject ${String(input)}`)
    }

    // Explicit ./ prefix still treats dot-TLD filenames as local files; nested segments like src/github.com/pkg.ts also work.
    assert.deepEqual(parseWorkspaceFileRef('./github.com/local.md'), { path: 'github.com/local.md' })
    assert.deepEqual(parseWorkspaceFileRef('src/github.com/pkg.ts'), { path: 'src/github.com/pkg.ts' })
  })
})
