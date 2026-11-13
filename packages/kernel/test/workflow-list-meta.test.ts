/**
 * WorkflowService.list() 摘要元数据回归。
 *
 * list() 读取每个已保存工作流脚本内容并经 extractMeta 填充可选的
 * description / whenToUse / phases；非法 meta 通过 metadataError 显式诊断，
 * 保留同目录健康脚本。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

function makeStateStore(): WorkflowStateStore {
  const map = new Map<string, unknown>()
  return {
    get<T>(key: string, initial: T): T {
      return (map.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      map.set(key, value)
    },
  }
}

const host: WorkflowServiceHost = {
  async spawnAgent() {
    throw new Error('no spawn in this suite')
  },
  async invokeAction() {
    throw new Error('no actions')
  },
  listActions() {
    return []
  },
  getConversation: () => {
    throw new Error('no conversations in this suite')
  },
  async abortConversationGuarded() {},
  emitEvent() {},
  async runGate() {
    return { ok: true, output: '' }
  },
}

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-wf-listmeta-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorkflowService.list() 填充 meta 摘要', { timeout: 60_000 }, () => {
  it('完整 meta：description/whenToUse/phases 全部填充', timeout, async () => {
    const dataDir = join(root, 'full')
    const dir = join(dataDir, 'workflows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'full.js'),
      [
        'export const meta = {',
        '  name: "full",',
        '  description: "完整元数据工作流",',
        '  whenToUse: "需要多阶段编排时",',
        '  phases: [',
        '    { title: "阶段一", detail: "调研", model: "faux/faux-1" },',
        '    { title: "阶段二" },',
        '  ],',
        '}',
        'return 1',
      ].join('\n'),
      'utf-8',
    )
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const items = service.list()
      assert.equal(items.length, 1)
      const item = items[0]!
      assert.equal(item.name, 'full')
      assert.equal(item.path, join(dir, 'full.js'))
      assert.equal(item.description, '完整元数据工作流')
      assert.equal(item.whenToUse, '需要多阶段编排时')
      assert.ok(Array.isArray(item.phases) && item.phases.length === 2)
      assert.deepEqual(
        { ...item.phases[0]! },
        { title: '阶段一', detail: '调研', model: 'faux/faux-1' },
      )
      assert.deepEqual({ ...item.phases[1]! }, { title: '阶段二' })
      assert.equal('detail' in (item.phases[1] ?? {}), false)
      assert.equal('model' in (item.phases[1] ?? {}), false)
    } finally {
      await service.close()
    }
  })

  it('仅必填 meta：description 填充、可选字段缺省', timeout, async () => {
    const dataDir = join(root, 'minimal')
    const dir = join(dataDir, 'workflows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'minimal.js'),
      'export const meta = { name: "minimal", description: "最小声明" }\nreturn 1',
      'utf-8',
    )
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const items = service.list()
      assert.equal(items.length, 1)
      const item = items[0]!
      assert.equal(item.name, 'minimal')
      assert.equal(item.path, join(dir, 'minimal.js'))
      assert.equal(item.description, '最小声明')
      assert.equal('whenToUse' in item, false)
      assert.equal('phases' in item, false)
    } finally {
      await service.close()
    }
  })

  it('meta 非纯字面量（模板插值）：返回 metadataError，不阻断健康脚本', timeout, async () => {
    const dataDir = join(root, 'impure')
    const dir = join(dataDir, 'workflows')
    mkdirSync(dir, { recursive: true })
    // 有 meta 声明但用了插值：extractMeta 拒绝，列表保留显式诊断。
    writeFileSync(
      join(dir, 'impure.js'),
      'const v = "x"\nexport const meta = { name: "impure", description: `d-${v}` }\nreturn 1',
      'utf-8',
    )
    // 同目录另一个健康脚本仍应出现在列表里。
    writeFileSync(
      join(dir, 'healthy.js'),
      'export const meta = { name: "healthy", description: "ok" }\nreturn 1',
      'utf-8',
    )
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const items = service.list()
      assert.equal(items.length, 2)
      const impure = items.find((i) => i.name === 'impure')
      const healthy = items.find((i) => i.name === 'healthy')
      assert.ok(impure !== undefined)
      assert.equal(impure.name, 'impure')
      assert.equal(impure.path, join(dir, 'impure.js'))
      assert.equal(impure.description, undefined)
      assert.match(impure.metadataError ?? '', /PURE LITERAL|interpolation/)
      assert.equal(healthy?.metadataError, undefined)
      assert.equal(healthy?.description, 'ok')
    } finally {
      await service.close()
    }
  })

  it('非 workflow 普通 .js 与非法名称仍被排除', timeout, async () => {
    const dataDir = join(root, 'exclude')
    const dir = join(dataDir, 'workflows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'plain.js'), 'console.log("not a workflow")', 'utf-8')
    writeFileSync(join(dir, 'weird name.js'), 'export const meta = { name: "w", description: "d" }\nreturn 1', 'utf-8')
    writeFileSync(
      join(dir, 'real.js'),
      'export const meta = { name: "real", description: "d" }\nreturn 1',
      'utf-8',
    )
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const items = service.list()
      assert.equal(items.length, 1)
      assert.equal(items[0]?.name, 'real')
    } finally {
      await service.close()
    }
  })
})
