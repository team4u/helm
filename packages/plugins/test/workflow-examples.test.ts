import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { precheckScriptSyntax } from '../src/workflow/engine/runtime.js'

const timeout = { timeout: 60_000 } as const
const examplesDir = join(process.cwd(), '..', '..', 'docs', 'workflows', 'examples')

for (const name of ['cross-review', 'module-dev', 'arch-master']) {
  test(`workflow example ${name} passes syntax and metadata precheck`, timeout, () => {
    const source = readFileSync(join(examplesDir, `${name}.js`), 'utf8')
    const checked = precheckScriptSyntax(source)
    assert.equal(checked.meta.name, name)
    assert.ok(checked.meta.description.length > 0)
    assert.ok(checked.body.length > 0)
  })
}
