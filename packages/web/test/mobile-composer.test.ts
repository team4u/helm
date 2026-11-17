import test from 'node:test'
import assert from 'node:assert/strict'
import { busyEnterMode, getComposerPlaceholder } from '../src/conversation/composer-model.js'

test('mobile placeholder copy: extremely short on small screens to avoid wrapping', { timeout: 60_000 }, () => {
  // Mobile / small-screen mode
  const mobileDefault = getComposerPlaceholder(false, true)
  assert.equal(mobileDefault, 'Type a message…')
  assert.doesNotMatch(mobileDefault, /⌘/)
  assert.doesNotMatch(mobileDefault, /[；;]/)

  const mobileWorking = getComposerPlaceholder(true, true)
  assert.equal(mobileWorking, 'Add notes or queued instructions…')
  assert.doesNotMatch(mobileWorking, /⌘/)

  // Desktop full-featured mode
  const desktopDefault = getComposerPlaceholder(false, false)
  assert.equal(desktopDefault, 'Type a message; / for commands and skills, ⌘V to paste attachments')
  assert.match(desktopDefault, /⌘V to paste attachments/)

  const desktopWorking = getComposerPlaceholder(true, false)
  assert.match(desktopWorking, /⌘\/Ctrl\+Enter/)
  // Default busy mode: Enter steers ahead; ⌘/Ctrl+Enter queues the send.
  assert.match(desktopWorking, /(Enter steers · ⌘\/Ctrl\+Enter queues)/)
})

test('default when-busy policy: Enter steers, ⌘/Ctrl+Enter queues (pure functions)', { timeout: 60_000 }, () => {
  // Enter (no modifiers) defaults to steering.
  assert.equal(busyEnterMode(false), 'steer')
  // ⌘/Ctrl+Enter explicitly queues the send.
  assert.equal(busyEnterMode(true), 'followUp')
})
