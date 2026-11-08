/**
 * 产物预览语法高亮语言推导测试：文件名后缀优先、mimeType 兜底、
 * 无法识别返回空串（回退普通代码样式，不猜造语言）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLanguage, languageFromFilename, languageFromMime } from '../src/conversation/code-language.js'

test('languageFromFilename 按后缀推导语言', { timeout: 60_000 }, () => {
  assert.equal(languageFromFilename('index.ts'), 'typescript')
  assert.equal(languageFromFilename('App.TSX'), 'typescript')
  assert.equal(languageFromFilename('main.mjs'), 'javascript')
  assert.equal(languageFromFilename('config.cjs'), 'javascript')
  assert.equal(languageFromFilename('data.json'), 'json')
  assert.equal(languageFromFilename('run.py'), 'python')
  assert.equal(languageFromFilename('deploy.sh'), 'bash')
  assert.equal(languageFromFilename('style.css'), 'css')
  assert.equal(languageFromFilename('theme.scss'), 'scss')
  assert.equal(languageFromFilename('page.html'), 'xml')
  assert.equal(languageFromFilename('feed.xml'), 'xml')
  assert.equal(languageFromFilename('query.sql'), 'sql')
  assert.equal(languageFromFilename('ci.yaml'), 'yaml')
  assert.equal(languageFromFilename('ci.YML'), 'yaml')
  assert.equal(languageFromFilename('pyproject.toml'), 'ini')
  assert.equal(languageFromFilename('README.md'), 'markdown')
  assert.equal(languageFromFilename('notes.markdown'), 'markdown')
  assert.equal(languageFromFilename('lib.rs'), 'rust')
  assert.equal(languageFromFilename('main.go'), 'go')
  assert.equal(languageFromFilename('changes.diff'), 'diff')
  assert.equal(languageFromFilename('x.patch'), 'diff')
})

test('languageFromFilename 无法识别时返回空串', { timeout: 60_000 }, () => {
  assert.equal(languageFromFilename('binary'), '')
  assert.equal(languageFromFilename('archive.tar'), '')
  assert.equal(languageFromFilename('.dotfile'), '')
  assert.equal(languageFromFilename('trailing.'), '')
  assert.equal(languageFromFilename(undefined), '')
})

test('languageFromMime 按 mimeType 推导语言（容忍参数与大小写）', { timeout: 60_000 }, () => {
  assert.equal(languageFromMime('text/markdown; charset=utf-8'), 'markdown')
  assert.equal(languageFromMime('application/json'), 'json')
  assert.equal(languageFromMime('Application/JSON'), 'json')
  assert.equal(languageFromMime('application/javascript'), 'javascript')
  assert.equal(languageFromMime('application/x-sh'), 'bash')
  assert.equal(languageFromMime('application/x-yaml'), 'yaml')
  assert.equal(languageFromMime('text/css'), 'css')
  assert.equal(languageFromMime('text/html'), 'xml')
  assert.equal(languageFromMime('application/xml'), 'xml')
  assert.equal(languageFromMime('text/x-diff'), 'diff')
  assert.equal(languageFromMime('text/plain'), '')
  assert.equal(languageFromMime(''), '')
  assert.equal(languageFromMime(undefined), '')
})

test('detectLanguage 后缀优先、mimeType 兜底', { timeout: 60_000 }, () => {
  assert.equal(detectLanguage('script.ts', 'text/plain'), 'typescript')
  assert.equal(detectLanguage('blob', 'application/json'), 'json')
  assert.equal(detectLanguage(undefined, 'application/json'), 'json')
  assert.equal(detectLanguage('archive.bin', 'application/octet-stream'), '')
  assert.equal(detectLanguage(undefined, undefined), '')
})
