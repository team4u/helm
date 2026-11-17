/**
 * Shared locale contract tests (@helm/protocol/src/locale.ts):
 * - supported locale set and default fallback;
 * - normalizeLocaleTag: zh-* -> zh-CN, everything else (incl. invalid input) -> en;
 * - parseLocalizedText boundary validation (display copy);
 * - parseNonEmptyLocalizedText strict display-metadata guard (registration boundaries);
 * - LOCALIZED_TEXT_JSON_SCHEMA reusable output-validation fragment shape;
 * - resolveLocalizedText fallback chain and createLocaleTranslator binding.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_HELM_LOCALE,
  HELM_LOCALES,
  LOCALIZED_TEXT_JSON_SCHEMA,
  createLocaleTranslator,
  isHelmLocale,
  normalizeLocaleTag,
  parseLocalizedText,
  parseNonEmptyLocalizedText,
  resolveLocalizedText,
} from '../src/index.js'

test('HELM_LOCALES: supported set and default fallback are stable', { timeout: 60_000 }, () => {
  assert.deepEqual(HELM_LOCALES, ['en', 'zh-CN'])
  assert.equal(DEFAULT_HELM_LOCALE, 'en')
})

test('normalizeLocaleTag: zh-* normalizes to zh-CN and all other values fall back to en', { timeout: 60_000 }, () => {
  // zh family: bare zh and every zh-* variant collapse to zh-CN
  for (const tag of ['zh', 'zh-CN', 'zh-cn', 'zh-TW', 'zh-HK', 'zh-SG', 'zh-Hans', 'zh-Hant', 'ZH', ' zh-CN ']) {
    assert.equal(normalizeLocaleTag(tag), 'zh-CN', `expected zh-CN for ${JSON.stringify(tag)}`)
  }
  // en family and unsupported languages fall back to en
  for (const tag of ['en', 'EN', 'en-US', 'en-GB', 'fr', 'ja-JP', 'pt-BR']) {
    assert.equal(normalizeLocaleTag(tag), 'en', `expected en for ${JSON.stringify(tag)}`)
  }
  // invalid values fall back to en (never throw)
  for (const tag of ['', '   ', 'garbage', 'zh_CN', '42', null, undefined]) {
    assert.equal(normalizeLocaleTag(tag as string | null | undefined), 'en', `expected en fallback for ${JSON.stringify(tag)}`)
  }
  assert.equal(normalizeLocaleTag(42 as unknown as string), 'en', 'non-string input falls back to en')
})

test('isHelmLocale: only exact supported locale values match', { timeout: 60_000 }, () => {
  assert.equal(isHelmLocale('en'), true)
  assert.equal(isHelmLocale('zh-CN'), true)
  for (const value of ['zh-cn', 'ZH-CN', 'EN', 'fr', '', 42, null, undefined, { en: 'x' }]) {
    assert.equal(isHelmLocale(value), false, `expected false for ${JSON.stringify(value)}`)
  }
})

test('parseLocalizedText: validates display copy at the boundary', { timeout: 60_000 }, () => {
  // plain strings pass through (backwards compatible with existing string fields)
  assert.equal(parseLocalizedText('hello'), 'hello')
  assert.equal(parseLocalizedText(''), '')
  // per-locale maps with supported keys and string values are accepted
  assert.deepEqual(parseLocalizedText({ en: 'Hi' }), { en: 'Hi' })
  assert.deepEqual(parseLocalizedText({ 'zh-CN': '你好' }), { 'zh-CN': '你好' })
  assert.deepEqual(parseLocalizedText({ en: 'Hi', 'zh-CN': '你好' }), { en: 'Hi', 'zh-CN': '你好' })
  // rejected shapes: nothing, wrong container kinds, bad keys or values
  for (const value of [undefined, null, 42, true, [], {}, { fr: 'x' }, { 'zh-cn': 'x' }, { en: 1 }, { en: 'Hi', fr: 'x' }]) {
    assert.equal(parseLocalizedText(value), undefined, `expected rejection for ${JSON.stringify(value)}`)
  }
})

test('parseNonEmptyLocalizedText: strict display-metadata guard (non-blank copy, supported locale keys only)', { timeout: 60_000 }, () => {
  // plain strings: non-blank passes through untouched; blank/whitespace-only rejected (trim rule)
  assert.equal(parseNonEmptyLocalizedText('hello'), 'hello')
  assert.equal(parseNonEmptyLocalizedText('  padded  '), '  padded  ')
  for (const value of ['', '   ', '\t\n ']) {
    assert.equal(parseNonEmptyLocalizedText(value), undefined, `expected rejection for ${JSON.stringify(value)}`)
  }
  // per-locale maps with supported keys and non-blank copy are accepted
  assert.deepEqual(parseNonEmptyLocalizedText({ en: 'Hi' }), { en: 'Hi' })
  assert.deepEqual(parseNonEmptyLocalizedText({ 'zh-CN': '你好' }), { 'zh-CN': '你好' })
  assert.deepEqual(parseNonEmptyLocalizedText({ en: 'Hi', 'zh-CN': '你好' }), { en: 'Hi', 'zh-CN': '你好' })
  // one blank entry invalidates the whole map (display metadata must never render empty copy)
  for (const value of [{ en: '' }, { en: 'Hi', 'zh-CN': ' ' }, { 'zh-CN': '\t' }]) {
    assert.equal(parseNonEmptyLocalizedText(value), undefined, `expected rejection for ${JSON.stringify(value)}`)
  }
  // unsupported locale keys (exact match, case sensitive) and non-string values are rejected
  for (const value of [{ fr: 'x' }, { 'zh-cn': 'x' }, { 'ZH-CN': 'x' }, { en: 1 }, { en: 'Hi', fr: 'x' }]) {
    assert.equal(parseNonEmptyLocalizedText(value), undefined, `expected rejection for ${JSON.stringify(value)}`)
  }
  // wrong container kinds and empty maps never satisfy the guard
  for (const value of [{}, [], 42, true, null, undefined]) {
    assert.equal(parseNonEmptyLocalizedText(value), undefined, `expected rejection for ${JSON.stringify(value)}`)
  }
})

test('LOCALIZED_TEXT_JSON_SCHEMA: reusable fragment locks the string-or-locale-map output shape', { timeout: 60_000 }, () => {
  // structural lock: action outputs declaring LocalizedText fields accept a non-empty
  // plain string or a supported-locale map (>=1 entry, no other keys), nothing else
  assert.deepEqual(LOCALIZED_TEXT_JSON_SCHEMA, {
    anyOf: [
      { type: 'string', minLength: 1 },
      {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: { en: { type: 'string' }, 'zh-CN': { type: 'string' } },
      },
    ],
  })
})

test('resolveLocalizedText: uses requested, default, then declaration-order fallbacks', { timeout: 60_000 }, () => {
  // plain string is locale-independent
  assert.equal(resolveLocalizedText('hello', 'zh-CN'), 'hello')
  assert.equal(resolveLocalizedText('hello', 'en'), 'hello')
  // exact hit wins
  const both = { en: 'Hi', 'zh-CN': '你好' }
  assert.equal(resolveLocalizedText(both, 'zh-CN'), '你好')
  assert.equal(resolveLocalizedText(both, 'en'), 'Hi')
  // missing requested locale falls back to the default locale
  assert.equal(resolveLocalizedText({ en: 'Hi' }, 'zh-CN'), 'Hi')
  // missing default falls back to the first declared entry in HELM_LOCALES order
  assert.equal(resolveLocalizedText({ 'zh-CN': '你好' }, 'en'), '你好')
})

test('createLocaleTranslator: binds a minimal translator to one locale', { timeout: 60_000 }, () => {
  const zh = createLocaleTranslator('zh-CN')
  const en = createLocaleTranslator('en')
  assert.equal(zh('plain'), 'plain', 'plain strings pass through untouched')
  assert.equal(zh({ en: 'Hi', 'zh-CN': '你好' }), '你好')
  assert.equal(en({ en: 'Hi', 'zh-CN': '你好' }), 'Hi')
  assert.equal(en({ 'zh-CN': '你好' }), '你好', 'falls back to the only declared entry')
  // same input resolves identically across calls (pure function)
  assert.equal(zh({ en: 'Hi', 'zh-CN': '你好' }), zh({ en: 'Hi', 'zh-CN': '你好' }))
})
