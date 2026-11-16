/**
 * @helm/plugin-client HelmIcon icon registry and Fast Refresh contract tests:
 * - Verify that the added icons 'laptop' / 'server' / 'circle-slash' / 'file'
 *   really render the corresponding lucide SVGs;
 * - Verify that unknown names and prototype-chain keys (e.g. 'toString') safely
 *   fall back to Circle;
 * - Verify the HelmIconName type export and the icons.tsx Fast Refresh rule
 *   (only components and types are exported).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { HelmIcon, type HelmIconName } from '../src/index.js'
import * as IconsModule from '../src/icons.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

test('HelmIcon: supports laptop / server / circle-slash / file and the shared extra vector icons (SSR)', { timeout: 60_000 }, () => {
  const cases: ReadonlyArray<[HelmIconName, RegExp]> = [
    ['laptop', /lucide-laptop/],
    ['server', /lucide-server/],
    ['circle-slash', /lucide-circle-slash/],
    ['file', /lucide-file(?!-)/],
    ['arrow-down', /lucide-arrow-down(?!-)/],
    ['arrow-down-to-line', /lucide-arrow-down-to-line/],
    ['git-pull-request', /lucide-git-pull-request/],
    ['list-filter', /lucide-list-filter/],
    ['more-horizontal', /lucide-ellipsis/],
  ]
  for (const [name, pattern] of cases) {
    const html = renderToString(e(HelmIcon, { name, size: 16 }))
    assert.match(html, /<svg\b/, `${name} should render an SVG element`)
    assert.match(html, pattern, `${name} should render the matching lucide icon instead of the fallback circle`)
    assert.doesNotMatch(html, /\blucide-circle(?:\s|")/, `${name} must not degrade to the hollow Circle`)
  }

  // Case and whitespace normalization also hits the registry
  const trimmed = renderToString(e(HelmIcon, { name: '  Laptop  ' }))
  assert.match(trimmed, /lucide-laptop/)
})

test('HelmIcon: unknown icons and prototype-chain properties safely fall back to Circle', { timeout: 60_000 }, () => {
  for (const bad of [undefined, '', 'does-not-exist', 'toString', 'constructor']) {
    const html = renderToString(e(HelmIcon, { name: bad }))
    assert.match(html, /<svg\b/)
    assert.match(html, /lucide-circle(?:\s|")/, `${String(bad)} should safely fall back to Circle`)
  }
})

test('icons.tsx obeys the Fast Refresh rule (only the HelmIcon component is exported at runtime)', { timeout: 60_000 }, () => {
  assert.deepEqual(Object.keys(IconsModule), ['HelmIcon'])
  assert.equal(typeof IconsModule.HelmIcon, 'function')
  const source = readFileSync(new URL('../src/icons.tsx', import.meta.url), 'utf8')
  const nonTypeExports = source.match(/^export\s+(?!interface\b|type\b)(.+)$/gm) ?? []
  assert.equal(nonTypeExports.length, 1)
  assert.match(nonTypeExports[0]!, /^export function HelmIcon\b/)
})
