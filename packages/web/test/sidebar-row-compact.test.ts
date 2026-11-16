/**
 * 侧栏会话行紧凑左缘契约（CSS 源码级）：
 * 状态灯前置后标题曾被行内边距 + 12px 灯槽 + 8px main gap 推到距行边约 30px，
 * 用户反馈左侧显得空。收紧策略（只作用于带灯槽的行，不碰全体 nav-item 内边距）：
 * 1. 灯槽固定 8px 并以 -4px 左负边距伸入行内边距（槽宽固定保证跨行对齐、
 *    idle 空槽续行标题对齐不变）；
 * 2. 仅渲染 nav-status-slot 的行把 nav-item-main gap 收至 4px（标题紧贴灯槽），
 *    设置导航/视图行的图标位保持基础 8px gap；
 * 3. Agent 二级会话子列表外层缩进适度减小（margin-left 8px / padding-left 4px）。
 * 结构契约（灯在 nav-item-label 之前、idle 空槽保留、槽位数量）由
 * background-activity.test.ts 的 SSR 断言锁定，此处只锁尺寸来源不重复断结构。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { readHostStyles } from './helpers/host-styles.js'

// 读取源码后统一换行（Windows checkout 下 autocrlf 会产生 CRLF，正则不得依赖 LF）
const styles = readHostStyles().replace(/\r\n/g, '\n')
const navigationSource = readFileSync(new URL('../src/styles/navigation.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** 提取指定选择器声明块的内部文本（花括号配对；选择器需精确到含结尾 ` {`）。 */
function cssBlock(source: string, selector: string): string | null {
  const idx = source.indexOf(`${selector} {`)
  if (idx < 0) return null
  const start = source.indexOf('{', idx)
  let depth = 0
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start + 1, i)
    }
  }
  return null
}

test('紧凑灯槽：nav-status-slot 固定 8px 槽宽 + -4px 左负边距伸入行内边距', { timeout: 60_000 }, () => {
  const slot = cssBlock(navigationSource, '.nav-status-slot')
  assert.ok(slot, 'navigation.css 必须保留 .nav-status-slot 规则（灯位契约）')
  assert.match(slot, /width:\s*8px/, '灯槽压至 8px（原 12px 过宽，左侧显空）')
  assert.match(slot, /margin-left:\s*-4px/, '灯槽以 -4px 左负边距伸入行内边距，灯芯贴近行左缘')
  assert.match(slot, /flex-shrink:\s*0/, '槽宽固定不收缩：idle 空槽保持续行标题跨行对齐')
})

test('仅带灯槽的行收紧 main gap 至 4px：设置导航/视图行保持基础 8px 不受波及', { timeout: 60_000 }, () => {
  const tightened = cssBlock(navigationSource, '.nav-item-main:has(> .nav-status-slot)')
  assert.ok(tightened, '必须存在仅命中带灯槽行的收紧规则（:has 直接子选择器）')
  assert.match(tightened, /gap:\s*4px/, '带灯槽行标题紧贴灯槽（8px → 4px）')
  const base = cssBlock(navigationSource, '.nav-item-main')
  assert.ok(base, '基础 .nav-item-main 规则必须存在')
  assert.match(base, /gap:\s*8px/, '基础 gap 保持 8px：设置导航/视图行的图标位不受影响')
})

test('不粗暴减全体 nav-item 内边距：紧凑只来自灯槽与 gap，行高与基础内边距维持原状', { timeout: 60_000 }, () => {
  const item = cssBlock(navigationSource, '.nav-item')
  assert.ok(item)
  assert.match(item, /padding:\s*5px 10px/, '全体 nav-item 内边距保持 5px 10px 基线（防止回归成粗暴减 padding）')
})

test('Agent 二级会话子列表缩进适度减小：margin-left 8px / padding-left 4px', { timeout: 60_000 }, () => {
  const list = cssBlock(navigationSource, '.agent-standing-group .agent-conversations-list')
  assert.ok(list)
  assert.match(list, /margin:\s*4px 0 2px 8px/, '外层左缩进 12px → 8px（相对一级站位行仍保留层级差）')
  assert.match(list, /padding-left:\s*4px/, '竖线导轨内缩进 6px → 4px')
})

test('收紧规则全部收敛在 navigation.css 宿主样式分片内（级联位置与其它分片不冲突）', { timeout: 60_000 }, () => {
  // 拼接态与分片源同时含这些选择器：防止规则被挪到其它分片后级联顺序漂移
  for (const selector of ['.nav-status-slot', '.nav-item-main:has(> .nav-status-slot)']) {
    assert.ok(styles.includes(selector), `${selector} 必须存在于宿主样式契约源`)
    assert.ok(navigationSource.includes(selector), `${selector} 必须收敛在 navigation.css 分片内`)
  }
})
