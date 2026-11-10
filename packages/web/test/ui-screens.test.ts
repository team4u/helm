import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

// ScreenHost 宿主契约（DSL 归一化测试已迁 packages/kernel/test/json-render-dsl.test.ts）。

test('ScreenHost 零插件 ID 特判，所有 screen 统一经 PluginUiView 渲染（herdr 专用映射已清退）', { timeout: 60_000 }, async () => {
  const source = await readFile(new URL('../src/screens/ScreenHost.tsx', import.meta.url), 'utf-8')
  // herdr 专用同构映射已删除：不再出现任何插件 ID 字符串特判
  assert.ok(!source.includes('builtin:herdr'), 'ScreenHost 不得出现 builtin:herdr 字符串特判')
  assert.ok(!source.includes('HerdrOverviewScreen'), 'HerdrOverviewScreen 同构映射应已删除')
  assert.ok(!source.includes('superagent'), 'ScreenHost 不得出现 superagent 字符串特判')
  assert.ok(!source.includes('RecallGraphScreen'), 'RecallGraphScreen 专用组件应已删除')
  assert.ok(source.includes('PluginUiView'), '所有 screen 一律经 PluginUiView 渲染')
  try {
    await readFile(new URL('../src/screens/HerdrOverviewScreen.tsx', import.meta.url), 'utf-8')
    assert.fail('HerdrOverviewScreen.tsx 应已删除')
  } catch (err) {
    assert.ok((err as NodeJS.ErrnoException).code === 'ENOENT')
  }
})

test('ScreenHost 从对应 target 组装 ScreenProps（params/isSplit/setParams 经 slotProps 注入）', { timeout: 60_000 }, async () => {
  const source = await readFile(new URL('../src/screens/ScreenHost.tsx', import.meta.url), 'utf-8')
  // 主/分屏分别取自 splitTarget / primaryTarget，参数互不串扰
  assert.match(source, /isSplit \? store\.splitTarget : store\.primaryTarget/)
  // 协议标准 ScreenProps 四字段全部注入 slotProps
  for (const field of ['pluginId', 'screenId', 'isSplit', 'params', 'setParams']) {
    assert.ok(source.includes(field), `slotProps 须包含 ${field}`)
  }
  // setParams 绑定 store 唯一导航机制，push 选项透传
  assert.match(source, /store\.setScreenParams\(patch, \{ split: isSplit === true, push: options\?\.push \}\)/)
})

