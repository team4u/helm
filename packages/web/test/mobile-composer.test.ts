import test from 'node:test'
import assert from 'node:assert/strict'
import { busyEnterMode, getComposerPlaceholder } from '../src/conversation/composer-model.js'

test('移动端 Placeholder 文案优化：小屏/移动端极短防折行', { timeout: 60_000 }, () => {
  // 移动端/小屏幕模式
  const mobileDefault = getComposerPlaceholder(false, true)
  assert.equal(mobileDefault, '输入消息…')
  assert.doesNotMatch(mobileDefault, /⌘/)
  assert.doesNotMatch(mobileDefault, /[；;]/)

  const mobileWorking = getComposerPlaceholder(true, true)
  assert.equal(mobileWorking, '补充说明或排队指令…')
  assert.doesNotMatch(mobileWorking, /⌘/)

  // 桌面端全功能模式
  const desktopDefault = getComposerPlaceholder(false, false)
  assert.equal(desktopDefault, '输入消息；/ 命令与技能，⌘V 粘贴附件')
  assert.match(desktopDefault, /⌘V 粘贴附件/)

  const desktopWorking = getComposerPlaceholder(true, false)
  assert.match(desktopWorking, /⌘\/Ctrl\+Enter/)
  // 默认插话模式：Enter 在前插话引导，⌘/Ctrl+Enter 排队发送。
  assert.match(desktopWorking, /Enter 插话引导 · ⌘\/Ctrl\+Enter 排队发送/)
})

test('正忙时默认插话模式：Enter steer，⌘/Ctrl+Enter 排队发送（纯函数）', { timeout: 60_000 }, () => {
  // Enter（无修饰键）默认插话引导。
  assert.equal(busyEnterMode(false), 'steer')
  // ⌘/Ctrl+Enter 显式排队发送。
  assert.equal(busyEnterMode(true), 'followUp')
})
