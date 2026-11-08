/**
 * Profile 保存组合测试：Web 载荷模型 × 真实 ProfileService.save。
 *
 * 验证 PUT 整体替换语义下的关键不变量：
 * 1. 只改展示名的载荷保存后，磁盘上的 model/nodeId/cwd/tags/runtime 完整保留；
 * 2. 清空 nodeId 的载荷保存后，profile.json 中 nodeId 键被删除（回退本机 local）；
 * 3. 未编辑 memory 时载荷省略 memory——磁盘 MEMORY.md 被 Agent 并发追加后保存，
 *    追加内容仍在（不因弹窗打开时的旧快照回写而丢失）。
 *
 * 直引 kernel 源码，确保断言约束真实持久化行为。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Profile } from '@helm/protocol'
import { ProfileService } from '../../kernel/src/services/profiles-skills.js'
import { parseProfileBody } from '../../kernel/src/http/validate.js'
import { buildProfileSavePayload, createDraft, editProfileField } from '../src/modals/profile-editor-model.js'

/** 模拟 GET /profiles/:id 返回的富化详情（profile.json 基础字段 + 文件全文）。 */
async function detailOf(svc: ProfileService, id: string): Promise<Profile> {
  const profile = await svc.get(id)
  assert.ok(profile, `profile ${id} 应存在`)
  return { ...profile, system: await svc.getSystem(id), memory: await svc.getMemory(id) }
}

test('Profile 文件资产拒绝未知运行时靶点字段，不静默回到本机', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-profile-invalid-target-'))
  try {
    const service = new ProfileService(dir)
    const invalid = { id: 'old-target', runtime: { kind: 'herdr', agent: 'pi', machine: 'remote-box' } }
    await assert.rejects(service.save(invalid), /未知字段.*machine/)
    const profileDir = join(dir, 'profiles', 'old-target')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'profile.json'), JSON.stringify(invalid))
    await assert.rejects(service.get('old-target'), /未知字段.*machine/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('只改 name 的载荷保存后完整保留执行配置；未编辑 memory 在并发追加后仍保留', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-profile-binding-'))
  try {
    const svc = new ProfileService(dir)

    // 初始落盘：完整配置（含执行节点/目录/运行时/tags）。
    const initial = await svc.save({
      id: 'coder',
      name: '代码工人',
      managedByPlugin: 'community:reporter',
      humanSelectable: false,
      model: 'zhipu/glm-4.6',
      nodeId: 'gpu-node',
      cwd: '/srv/work',
      runtime: { kind: 'herdr', agent: 'pi', nodeId: 'terminal-node' },
      tags: ['worker'],
      system: '# SYSTEM\n基础提示词',
      memory: '# MEMORY\n旧记忆',
    } as never)
    assert.equal(initial.id, 'coder')

    // 编辑器打开：加载详情（等价 GET /profiles/:id 富化形状）。
    const detail = await detailOf(svc, 'coder')
    const draft = createDraft(detail)

    // 弹窗打开期间 Agent 向 MEMORY.md 并发追加新记忆（update_memory append）。
    await svc.updateMemory('coder', '新事实：用户偏好极简界面', 'append')

    // 用户只改展示名，保存。
    const edited = editProfileField(draft, { name: '重构工人' })
    const payload = buildProfileSavePayload(edited, { isNew: false })
    // 载荷层断言：完整基础配置 + 大文本省略。
    assert.equal(payload.name, '重构工人')
    assert.equal(payload.managedByPlugin, 'community:reporter')
    assert.equal(payload.humanSelectable, false)
    assert.equal(payload.model, 'zhipu/glm-4.6')
    assert.equal(payload.nodeId, 'gpu-node')
    assert.equal(payload.cwd, '/srv/work')
    assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'pi', nodeId: 'terminal-node' })
    assert.deepEqual(payload.tags, ['worker'])
    assert.equal('system' in payload, false)
    assert.equal('memory' in payload, false)

    // 经过与 PUT 相同的边界校验，再持久化，避免仅服务直调掩盖白名单漏字段。
    await svc.save(parseProfileBody({ ...payload, id: 'coder' }, { requireId: true }))

    const after = await detailOf(svc, 'coder')
    assert.equal(after.name, '重构工人', '展示名已更新')
    assert.equal(after.managedByPlugin, 'community:reporter', '编辑保存后不丢插件归属')
    assert.equal(after.humanSelectable, false, '编辑保存后不把常驻专属 Profile 变成可选角色')
    assert.equal(after.model, 'zhipu/glm-4.6', '只改名不丢 model')
    assert.equal(after.nodeId, 'gpu-node', '只改名不丢节点绑定')
    assert.equal(after.cwd, '/srv/work', '只改名不丢工作目录')
    assert.deepEqual(after.runtime, { kind: 'herdr', agent: 'pi', nodeId: 'terminal-node' })
    assert.deepEqual(after.tags, ['worker'], '只改名不丢 tags')
    assert.equal(after.system, '# SYSTEM\n基础提示词', 'system 文件未被旧快照覆盖')
    assert.equal(
      after.memory,
      '# MEMORY\n旧记忆\n新事实：用户偏好极简界面',
      '未编辑 memory 时保存不得覆盖 Agent 并发追加的内容',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('清空 nodeId 的载荷保存后 profile.json 不再回读出 nodeId（回退默认 local）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-profile-binding-'))
  try {
    const svc = new ProfileService(dir)
    const detail: Profile = {
      id: 'ops',
      name: '运维',
      nodeId: 'gpu-node',
      tags: ['worker'],
      system: '',
      memory: '',
    }
    await svc.save(detail)
    assert.equal((await svc.get('ops'))?.nodeId, 'gpu-node', '清除前节点绑定必须真实存在')
    const cleared = editProfileField(createDraft(detail), { nodeId: '  ' })
    const payload = buildProfileSavePayload(cleared, { isNew: false })
    assert.equal('nodeId' in payload, false, '清空 nodeId 归一为载荷省略')
    assert.equal(payload.name, '运维')

    await svc.save({ ...payload, id: 'ops' } as never)
    const after = await svc.get('ops')
    assert.ok(after)
    assert.equal(after.nodeId, undefined, '保存后磁盘不再持有 nodeId（删除覆盖而非保留旧值）')
    assert.equal(after.name, '运维')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('显式编辑过 memory 的载荷保存后整篇替换 MEMORY.md', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-profile-binding-'))
  try {
    const svc = new ProfileService(dir)
    await svc.save({
      id: 'writer',
      name: '写手',
      system: '# S',
      memory: '# MEMORY\n旧记忆',
    } as never)
    const detail = await detailOf(svc, 'writer')
    const draft = createDraft(detail)
    const edited = { ...draft, profile: { ...draft.profile, memory: '# MEMORY\n重写后的记忆' }, editedFields: new Set<'system' | 'memory'>(['memory']) }
    const payload = buildProfileSavePayload(edited, { isNew: false })
    assert.equal(payload.memory, '# MEMORY\n重写后的记忆')

    await svc.save({ ...payload, id: 'writer' } as never)
    assert.equal(await svc.getMemory('writer'), '# MEMORY\n重写后的记忆', '显式编辑过 memory 即整篇替换')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
