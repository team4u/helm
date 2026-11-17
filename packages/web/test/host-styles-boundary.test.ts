/**
 * 宿主样式分片归属契约（静态结构断言，非属性值正则）：
 * `.status-dot` 通用状态灯词汇（base / working / blocked / done / error /
 * background + keyframes + prefers-reduced-motion）是宿主公共设计系统资产，
 * 被 @helm/plugin-client 的 StatusLight 共享，必须完整归属 primitives.css；
 * navigation.css 只允许保留导航专有覆盖（如 .agent-standing-group 的 6px 小点），
 * 避免「共享原语依赖导航私有样式」的架构漂移与级联回归。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STYLES_DIR = join(__dirname, '../src/styles')
const primitives = readFileSync(join(STYLES_DIR, 'primitives.css'), 'utf8')
const navigation = readFileSync(join(STYLES_DIR, 'navigation.css'), 'utf8')

/** Selector-ownership probe: a shard owns a rule when the selector is declared at line start. */
const ownsRule = (css: string, selector: string): boolean =>
  new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).test(css)

test('样式边界：通用状态灯词汇完整归属 primitives.css（base/色调/空心环/动效/减动效）', { timeout: 60_000 }, () => {
  for (const selector of [
    '.status-dot',
    '.status-dot-working',
    '.status-dot-blocked',
    '.status-dot-done',
    '.status-dot-error',
    '.status-dot-background',
    '.status-dot-aborted',
    '.status-dot-pending',
  ]) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义公共状态灯规则 ${selector}`)
    assert.ok(!ownsRule(navigation, selector), `navigation.css 不得再定义通用状态灯规则 ${selector}`)
  }
  for (const keyframe of ['@keyframes status-dot-pulse', '@keyframes status-dot-background-pulse']) {
    assert.ok(primitives.includes(keyframe), `primitives.css 应携带 ${keyframe}`)
    assert.ok(!navigation.includes(keyframe), `navigation.css 不得携带 ${keyframe}`)
  }
  assert.ok(
    /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.status-dot-working/.test(primitives),
    'primitives.css 的减动效规则覆盖状态灯呼吸动画',
  )
  assert.ok(!navigation.includes('prefers-reduced-motion'), 'navigation.css 不再携带状态灯减动效规则')
})

test('样式边界：navigation.css 仅保留导航专有状态点覆盖（agent-standing-group 小点）', { timeout: 60_000 }, () => {
  assert.ok(
    ownsRule(navigation, '.agent-standing-group .status-dot'),
    '导航专属 6px 小点覆盖保留在 navigation.css',
  )
  assert.ok(
    !ownsRule(primitives, '.agent-standing-group .status-dot'),
    '导航专属覆盖不得漂移进公共分片',
  )
})

test('样式边界：StatusLight 统一外壳与 sr-only 文本归属 primitives.css（共享原语可用的公共资产）', { timeout: 60_000 }, () => {
  for (const selector of ['.helm-status-light', '.helm-status-light .status-dot', '.helm-sr-only']) {
    assert.ok(ownsRule(primitives, selector), `primitives.css 应定义共享状态灯外壳规则 ${selector}`)
    assert.ok(!ownsRule(navigation, selector), `navigation.css 不得定义 ${selector}`)
  }
})
