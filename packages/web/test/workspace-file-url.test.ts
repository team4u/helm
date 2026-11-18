import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { isDisallowedFileUrl, parseWorkspaceFileRef } from '../src/conversation/workspace-file-url.js'

describe('workspace-file-url: isDisallowedFileUrl', { timeout: 60_000 }, () => {
  test('recognizes file: scheme and bare Windows drive/UNC paths case-insensitively', { timeout: 60_000 }, () => {
    assert.equal(isDisallowedFileUrl('file:///etc/passwd'), true)
    assert.equal(isDisallowedFileUrl('  FILE:///C:/secret.txt  '), true)
    assert.equal(isDisallowedFileUrl('file:relative.txt'), true)
    assert.equal(isDisallowedFileUrl('C:/etc/secret.txt'), true)
    assert.equal(isDisallowedFileUrl('d:\\repo\\a.ts'), true)
    assert.equal(isDisallowedFileUrl('\\\\server\\share\\a.ts'), true)
    assert.equal(isDisallowedFileUrl('/etc/passwd'), false)
    assert.equal(isDisallowedFileUrl('https://example.com/file://foo'), false)
    assert.equal(isDisallowedFileUrl('docs/file.md'), false)
    assert.equal(isDisallowedFileUrl(undefined), false)
  })
})

describe('workspace-file-url: parseWorkspaceFileRef', { timeout: 60_000 }, () => {
  test('parses relative workspace paths and line/column fragments', { timeout: 60_000 }, () => {
    assert.deepEqual(parseWorkspaceFileRef('README.md'), { path: 'README.md' })
    assert.deepEqual(parseWorkspaceFileRef('./docs/guide.md'), { path: 'docs/guide.md' })
    assert.deepEqual(parseWorkspaceFileRef('docs/guide.md#install'), { path: 'docs/guide.md' })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#L12'), { path: 'src/app.ts', startLine: 12 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#L12-L34'), { path: 'src/app.ts', startLine: 12, endLine: 34 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#l5-10'), { path: 'src/app.ts', startLine: 5, endLine: 10 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts#L12C5-L34C10'), { path: 'src/app.ts', startLine: 12, endLine: 34 })
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

  test('narrows bare POSIX and Windows absolute paths strictly inside non-root conversationCwd', { timeout: 60_000 }, () => {
    assert.deepEqual(
      parseWorkspaceFileRef('/root/code/helm/packages/plugins/src/profile/skill/SKILL.md', {
        conversationCwd: '/root/code/helm',
        workspaceBaseDir: 'packages/plugins',
      }),
      { path: 'packages/plugins/src/profile/skill/SKILL.md' },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('/Users/me/My%20Repo/docs/guide.md#L8-L16', {
        conversationCwd: '/Users/me/My Repo/',
      }),
      { path: 'docs/guide.md', startLine: 8, endLine: 16 },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('C:/Users/Alice/Repo/src/App.tsx#L4', {
        conversationCwd: 'c:\\users\\alice\\repo',
        workspaceBaseDir: 'src',
      }),
      { path: 'src/App.tsx', startLine: 4 },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('/mnt/c/Users/Alice/Repo/README.md', {
        conversationCwd: 'C:\\Users\\Alice\\Repo',
      }),
      { path: 'README.md' },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('/c/Users/Alice/Repo/README.md', {
        conversationCwd: 'C:\\Users\\Alice\\Repo',
      }),
      { path: 'README.md' },
    )

    // Reject missing cwd, filesystem-root cwd, outside paths, traversal, queries, and cross-shape paths
    assert.equal(parseWorkspaceFileRef('/repo/a.ts'), null)
    assert.equal(parseWorkspaceFileRef('/etc/passwd', { conversationCwd: '/' }), null)
    assert.equal(parseWorkspaceFileRef('C:/secret.txt', { conversationCwd: 'C:\\' }), null)
    assert.equal(parseWorkspaceFileRef('/repo/../../etc/passwd', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('/repo/..%2fetc/passwd', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('/repo-other/a.ts', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('/repo', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('/repo/a.ts?raw=1', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('C:/repo/a.ts', { conversationCwd: '/repo' }), null)
    assert.equal(parseWorkspaceFileRef('D:/Users/Alice/Repo/a.ts', { conversationCwd: 'C:\\Users\\Alice\\Repo' }), null)
    assert.equal(parseWorkspaceFileRef('/api/artifacts/1/content', { conversationCwd: 'C:\\Users\\Alice\\Repo' }), null)
  })

  test('parses compiler-style trailing :line(:col) suffixes', { timeout: 60_000 }, () => {
    assert.deepEqual(
      parseWorkspaceFileRef('packages/protocol/src/plugin.ts:420'),
      { path: 'packages/protocol/src/plugin.ts', startLine: 420 },
    )
    assert.deepEqual(parseWorkspaceFileRef('plugin.ts:420'), { path: 'plugin.ts', startLine: 420 })
    assert.deepEqual(parseWorkspaceFileRef('./src/app.ts:8'), { path: 'src/app.ts', startLine: 8 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:12:5'), { path: 'src/app.ts', startLine: 12 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:12-34'), { path: 'src/app.ts', startLine: 12, endLine: 34 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:12:5-34:9'), { path: 'src/app.ts', startLine: 12, endLine: 34 })
    assert.deepEqual(
      parseWorkspaceFileRef('../src/index.ts:8', { workspaceBaseDir: 'docs' }),
      { path: 'src/index.ts', startLine: 8 },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('/repo/src/a.ts:10-20', { conversationCwd: '/repo' }),
      { path: 'src/a.ts', startLine: 10, endLine: 20 },
    )
    assert.deepEqual(
      parseWorkspaceFileRef('C:/repo/src/a.ts:7', { conversationCwd: 'C:\\repo' }),
      { path: 'src/a.ts', startLine: 7 },
    )
    // Explicit #L fragment wins over the colon suffix when both are present.
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:12#L30'), { path: 'src/app.ts', startLine: 30 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:12#L30-L40'), { path: 'src/app.ts', startLine: 30, endLine: 40 })
    // Invalid line numbers keep the suffix as part of the path (no silent rewrites).
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:0'), { path: 'src/app.ts:0' })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:20-10'), { path: 'src/app.ts', startLine: 20 })
    assert.deepEqual(parseWorkspaceFileRef('src/app.ts:12345678'), { path: 'src/app.ts:12345678' })
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
      'localhost:3000',
      'localhost/foo',
      '127.0.0.1/foo',
      '127.0.0.1:8080/bar',
      '127.0.0.1:8080',
      'github.com/foo/bar',
      'EXAMPLE.ORG:8443/docs',
      'EXAMPLE.ORG:8443',
      'docs.io/guide',
      'app.dev/index',
      // Scheme-ish single tokens must not be reinterpreted as file:line refs.
      'telnet:23',
    ]
    for (const input of rejected) {
      assert.equal(parseWorkspaceFileRef(input, { conversationCwd: '/repo' }), null, `should reject ${String(input)}`)
    }

    // Explicit ./ prefix still treats dot-TLD filenames as local files; nested segments like src/github.com/pkg.ts also work.
    assert.deepEqual(parseWorkspaceFileRef('./github.com/local.md'), { path: 'github.com/local.md' })
    assert.deepEqual(parseWorkspaceFileRef('src/github.com/pkg.ts'), { path: 'src/github.com/pkg.ts' })
  })
})
