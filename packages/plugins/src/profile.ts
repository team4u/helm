/**
 * builtin:profile：常驻角色与技能底座（locked: true）。
 *
 * 职责（记忆已拆分至 builtin:memory，本插件零记忆逻辑）：
 * - 启动自举系统级内置技能 skills/helm-cli（受管覆盖）与默认 assistant
 *   Profile 的托管元数据；
 * - before_turn 注入 profile.system（SYSTEM.md）、profile.skills（可用技能
 *   目录）与 profile.assets-missing（SYSTEM.md 缺失告警）；
 * - 低优先级 before_turn（在默认优先级的工具剥离钩子之后运行）按当回合
 *   实际 turn.tools 注入 profile.catalog（跨 Profile 协作目录；派工工具被
 *   剥离的叶子子代理不注入、builtin:workflow 停用时无派工工具则不注入）；
 * - 注册 load_skill 工具（Profile 白名单 + 插件启停实时判定）与
 *   list_mentionable 幂等动作（@ 补全源，自动映射 HTTP / helm profile
 *   list_mentionable CLI）；
 * - 左栏 assistant Profile 站位导航（conversation:profile:assistant，不依赖
 *   某一具体会话存在）。
 */
import { HelmError, isSkillAvailable, type HelmHostProfilesPort, type PluginDefinition, type Profile, type SkillSummary } from '@helm/protocol';
import { HELM_CLI_SKILL_ASSET, PROFILE_MANAGED_BY } from './profile/assets.js';
import {
  activeRuntimeKinds,
  describeHint,
  extractSystemSummary,
  isCollaborationCandidate,
  renderProfileCatalogSection,
  toCatalogEntry,
  type ProfileCatalogEntry,
} from './profile/catalog.js';

const DEFAULT_PROFILE_ID = 'assistant';

export {
  HELM_CLI_SKILL_ID,
  HELM_CLI_SKILL_ASSET,
  PROFILE_MANAGED_BY,
  renderSkillTemplate,
} from './profile/assets.js'
export {
  PROFILE_SUMMARY_MAX_CODEPOINTS,
  activeRuntimeKinds,
  describeHint,
  describePosition,
  extractSystemSummary,
  isCollaborationCandidate,
  renderProfileCatalogSection,
  toCatalogEntry,
  truncateCodePoints,
  type ProfileCatalogEntry,
} from './profile/catalog.js'

/**
 * 自举默认 assistant Profile 的托管元数据：缺失时显式补写
 * managedByPlugin: 'builtin:profile'（已是其他值或已存在时原样保留，
 * 不做旧数据归一化）；默认 Profile 不存在属内核未初始化异常，如实上抛。
 * 写入经公共 profiles.save 整体保存（其余字段原样透传）。
 */
async function ensureDefaultProfileManaged(profiles: HelmHostProfilesPort): Promise<void> {
  const existing = await profiles.get(DEFAULT_PROFILE_ID);
  if (existing === undefined) {
    throw new Error(
      `默认 profile '${DEFAULT_PROFILE_ID}' 不存在（内核 ensureDefault 应先于插件启动执行）`,
    );
  }
  if (existing.managedByPlugin !== undefined) return;
  const next: Profile = { ...existing, managedByPlugin: PROFILE_MANAGED_BY };
  await profiles.save(next);
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** 目录注入钩子优先级：低于默认 0，确保在默认优先级的工具剥离钩子（如路由
 * 模式收敛）之后运行，按届时的实际 turn.tools 决定注入与否。 */
const CATALOG_HOOK_PRIORITY = -100;

export function createProfilePlugin(): PluginDefinition {
  return {
    id: 'builtin:profile',
    name: '角色与技能底座',
    description: '常驻底座：按会话绑定的 Profile 注入 SYSTEM.md 与可用技能目录，提供 load_skill 工具与默认助理角色。',
    icon: 'bot',
    version: '0.1.0',
    locked: true,
    definePlugin(ctx) {
      const { profiles, skills } = ctx.host;
      // 启动时同步系统级内置技能 skills/helm-cli/（Layer 1 + Layer 2）：
      // 受管系统资产以源码版本为准逐文件覆盖，缺失补齐；常规接口写入被拒。
      // 同时自举默认 assistant Profile 的托管元数据：缺失时显式补写
      // managedByPlugin（ensureDefault 不做归一化，由本插件自举声明）。
      ctx.service({
        id: 'profile-skills',
        async start() {
          await skills.ensureSkill(HELM_CLI_SKILL_ASSET);
          await ensureDefaultProfileManaged(profiles);
        },
        async stop() {},
      });

      /**
       * 读取 SYSTEM.md：文件被外部误删（not_found）时按空处理，
       * 但绝不沉默改变人格——① 向人类发一次性告警（按 profileId 独立去重，
       * 文件恢复即停、再次缺失可重新告警）；② 向模型注入显式的
       * <profile_assets_missing> 说明节，告知本轮人格资产缺失及其后果。
       * 其余错误（权限/IO 故障）如实上抛，绝不吞。
       */
      const missingNotified = new Set<string>()
      const readSystemOrEmpty = async (
        profileId: string,
      ): Promise<string> => {
        try {
          const text = await profiles.getSystem(profileId)
          missingNotified.delete(profileId) // 恢复即停；下次再缺失可重新告警
          return text
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') {
            if (!missingNotified.has(profileId)) {
              await ctx.host.emitEvent('notification', {
                type: 'notification',
                level: 'warning',
                title: `角色资产文件缺失：${profileId}/SYSTEM.md`,
                body: `Profile 资产 ${profileId}/SYSTEM.md 不存在（可能被外部误删），本回合按空内容处理；再次写入系统提示词可自愈重建`,
              })
              missingNotified.add(profileId)
            }
            return ''
          }
          throw err
        }
      }

      /**
       * 读取当前 Profile 真实配置 + 插件启用状态，按共享 isSkillAvailable 规则
       * 过滤技能目录（Profile.skills 缺省全部、[] 禁用全部、非空白名单；
       * 插件停用则其托管技能不可用）。每回合重读——运行时修改 Profile 或
       * 插件启停在下一回合即时生效。Profile 不存在属配置异常，显式报错。
       */
      const listAvailableSkills = async (profileId: string): Promise<SkillSummary[]> => {
        const profile = await profiles.get(profileId)
        if (profile === undefined) {
          throw new HelmError('profile_not_found', `会话绑定 profile '${profileId}' 不存在（技能目录无法按 Profile 过滤）`, 500, { profileId })
        }
        const enabledPluginIds = new Set(ctx.host.listPlugins().filter((p) => p.enabled).map((p) => p.id))
        const all = await skills.list()
        return all.filter((skill) => isSkillAvailable(skill, profile, enabledPluginIds))
      }

      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId;
        const [rawSystem, available] = await Promise.all([
          readSystemOrEmpty(profileId),
          listAvailableSkills(profileId),
        ]);
        const sections = [...turn.sections];
        if (rawSystem.trim()) sections.push({ id: 'profile.system', text: rawSystem });
        // 资产缺失必须向模型显式告知（不能沉默换人格）：SYSTEM.md 缺失/为空。
        if (!rawSystem.trim()) {
          sections.push({
            id: 'profile.assets-missing',
            text: [
              '<profile_assets_missing>',
              `本回合缺少 Profile '${profileId}' 的 SYSTEM.md（文件不存在或为空）。`,
              '你当前没有该 Profile 的人格设定：请告知用户资产缺失，谨慎回答，不要假装拥有特定人格；资产写入后自动恢复。',
              '</profile_assets_missing>',
            ].join('\n'),
          });
        }
        if (available.length) {
          const catalog = available.map((skill) =>
            `<skill id="${escapeXml(skill.id)}"><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description ?? '')}</description><references>${skill.references.map(escapeXml).join(', ')}</references></skill>`,
          ).join('\n');
          sections.push({
            id: 'profile.skills',
            text: `<available_skills>\n${catalog}\n</available_skills>\nUse load_skill to read a skill before applying it. Read reference files only as needed.`,
          });
        }
        return { action: 'transform', value: { ...turn, sections } };
      });

      /**
       * 读取候选 Profile 的 SYSTEM.md 提取单行摘要：缺失（not_found）
       * 只影响该候选的 summary 字段（undefined，不伪造简介），不告警——
       * 认知缺失告警纪律只针对「当前会话绑定 Profile」的人格资产（见
       * readSystemOrEmpty）；候选缺 SYSTEM 属配置态，不放大告警面。
       * 其余 IO / 权限错误如实上抛（不吞、不降级）。
       */
      const readCandidateSummary = async (profileId: string): Promise<string | undefined> => {
        try {
          const text = await profiles.getSystem(profileId)
          return extractSystemSummary(text)
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') return undefined
          throw err
        }
      }

      /**
       * 协作目录统一计算（补全动作与 before_turn 注入共用同一事实源）：
       * - 排除自身 / humanSelectable:false / 托管插件未启用 / runtime.kind
       *   无已启用 profile.runtime UI 贡献对应（详见 catalog.ts 规则）；
       * - 仅依据回合是否还有派工工具：builtin:workflow 对达到深度上限的受管
       *   子代理（编排叶子）在更高优先级钩子剥离 subagent/SubagentWorkflow
       *   后，此处自然返回空——不按 parentConversationId 一刀切（fork /
       *   SuperAgent worker 同样有父链，但应保留完整协作能力；一层子代理
       *   默认保留派工工具，同样注入目录）；
       * - 每次调用实时重读 Profile 目录与插件状态（增删改 / 启停下次生效）。
       * 任一候选摘要读取的非 not_found 错误如实上抛（显式失败）。
       */
      const computeCatalog = async (currentProfileId: string): Promise<ProfileCatalogEntry[]> => {
        const [allProfiles, pluginSummaries, uiContributions] = await Promise.all([
          profiles.list(),
          ctx.host.listPlugins(),
          ctx.host.listUi(),
        ])
        const dispatchTools = new Set(['subagent', 'SubagentWorkflow'])
        if (!pluginSummaries.some((plugin) => plugin.enabled && plugin.tools.some((name) => dispatchTools.has(name)))) {
          return []
        }
        const enabledPluginIds = new Set(pluginSummaries.filter((p) => p.enabled).map((p) => p.id))
        const runtimeKinds = activeRuntimeKinds(uiContributions)
        const candidates = allProfiles.filter((p) => isCollaborationCandidate(p, currentProfileId, enabledPluginIds, runtimeKinds))
        return Promise.all(
          candidates.map(async (profile) => ({
            ...toCatalogEntry(profile),
            summary: await readCandidateSummary(profile.id),
          })),
        )
      }

      /**
       * 本回合实际可用的派工工具名（只认 turn.tools 现存声明，避免幻影工具）。
       * 目录注入钩子以低于默认值的 priority 运行（见 CATALOG_HOOK_PRIORITY），
       * 因此此处看到的是默认优先级钩子（如路由模式剥离 subagent）收敛后的
       * 最终工具清单——补全动作拿不到回合工具时另行降级判定（见动作实现）。
       */
      const dispatchToolNames = (tools: readonly { name: string }[]): string[] =>
        ['subagent', 'SubagentWorkflow'].filter((name) => tools.some((t) => t.name === name))

      ctx.hook.onBeforeTurn(
        async (turn) => {
          // 无可用派工工具的回合不注入目录（避免教唆调用不存在的工具；深度
          // 上限的叶子子代理派工工具已被 builtin:workflow 钩子剥离，在此自然
          // 收敛）。工具收敛后的 tools 只读，不改动；不按 parentConversationId
          // 排除（fork / SuperAgent worker 同样有父链，应保留协作能力；
          // 一层子代理默认保留派工工具，同样注入目录）。
          const tools = dispatchToolNames(turn.tools)
          if (tools.length === 0) return { action: 'continue' }
          const entries = await computeCatalog(turn.conversation.profileId)
          if (entries.length === 0) return { action: 'continue' }
          const sections = [...turn.sections, { id: 'profile.catalog', text: renderProfileCatalogSection(entries, { dispatchToolNames: tools }) }]
          return { action: 'transform', value: { ...turn, sections } }
        },
        { priority: CATALOG_HOOK_PRIORITY },
      )

      // ---- @ 补全动作：list_mentionable（幂等只读；自动映射 HTTP / CLI） ----
      ctx.action<
        { query?: string; conversationId?: number },
        { items: Array<{ id: string; label: string; insertText: string; hint: string; icon: string }> }
      >({
        id: 'list_mentionable',
        description: '列出当前会话可 @ 点名协作的 Profile 候选（@ 补全源；--current 或显式 --conversation-id 选上下文）',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '过滤前缀（缺省空）' },
            conversationId: { type: 'number', description: '显式目标会话（CLI 无调用上下文时使用；Web 补全不传，以服务端上下文为准）' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  insertText: { type: 'string' },
                  hint: { type: 'string' },
                  icon: { type: 'string' },
                },
                required: ['id', 'label', 'insertText', 'hint', 'icon'],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
        idempotent: true,
        async handler(input, context) {
          // 身份裁决：调用上下文会话（Web / --current 注入的外层 conversationId）
          // 是唯一可信来源；input.conversationId 仅在无上下文时作为 CLI 显式
          // 目标，且必须经真实 getConversation 校验存在。两者都缺 → 显式
          // validation_error，绝不猜测默认会话。
          let conversationId = context.conversationId
          if (conversationId === undefined) {
            if (input.conversationId === undefined) {
              throw new HelmError(
                'validation_error',
                '缺少会话上下文：Web 补全自动携带；CLI 请用 --current 或 --conversation-id 显式指定',
                400,
              )
            }
            conversationId = input.conversationId
          }
          const conversation = ctx.host.getConversation(conversationId)
          const query = (input.query ?? '').trim().toLowerCase()
          // 补全无回合工具清单：按插件可用性判定候选（不伪称能确定最终工具
          // 清单——注入目录时另有回合级收敛，两者规则同源；嵌套子代理的
          // 回合级剥离由 builtin:workflow 钩子完成，补全面不再按父链排除）。
          const entries = await computeCatalog(conversation.profileId)
          const items = entries
            .filter((entry) => {
              if (query === '') return true
              const haystack = `${entry.id}\n${entry.name}\n${entry.summary ?? ''}`.toLowerCase()
              return haystack.includes(query)
            })
            .map((entry) => ({
              id: entry.id,
              label: `@${entry.id} · ${entry.name}${entry.runtimeKind === 'native' ? '' : ` (external:${entry.runtimeKind})`}`,
              insertText: `@${entry.id} `,
              hint: describeHint(entry),
              icon: 'bot',
            }))
          return { items }
        },
      })

      // ---- @ 补全源声明（复用宿主通用补全渲染；label 仅用于插件源间排序） ----
      ctx.ui.composerCompleter({
        id: 'profile-mentions',
        label: '点名角色',
        trigger: '@',
        priority: 100,
        source: { kind: 'action', actionId: 'list_mentionable' },
      })

      ctx.tool<{ skillId: string; path?: string }>({
        name: 'load_skill',
        description: '读取技能 SKILL.md，或按需读取技能目录内的参考文件。path 示例：references/guide.md。',
        inputSchema: {
          type: 'object',
          properties: { skillId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } },
          required: ['skillId'],
          additionalProperties: false,
        },
        async execute(input, context) {
          // 会话当前 Profile 的白名单与插件启停状态实时判定（与目录注入同规则）：
          // Profile 白名单外或托管插件停用 → 403 skill_not_available；
          // 技能不存在 → 404 not_found（不泄漏内容）。路径安全校验在
          // SkillService.readFile 原样保留（穿越/绝对路径/软链均拒绝）。
          // 注意：这只是认知目录边界，不是权限沙箱——bash/API 仍可读文件。
          const conversation = ctx.host.getConversation(context.conversationId);
          const profileId = conversation.profileId;
          const profile = await profiles.get(profileId);
          if (profile === undefined) {
            throw new HelmError('profile_not_found', `会话绑定 profile '${profileId}' 不存在，无法判定技能可用性`, 500, { profileId });
          }
          const enabledPluginIds = new Set(ctx.host.listPlugins().filter((p) => p.enabled).map((p) => p.id));
          const skill = (await skills.list()).find((s) => s.id === input.skillId);
          if (skill === undefined) {
            throw new HelmError('not_found', `技能不存在: ${input.skillId}`, 404, { skillId: input.skillId });
          }
          if (!isSkillAvailable(skill, profile, enabledPluginIds)) {
            throw new HelmError(
              'skill_not_available',
              `技能 '${input.skillId}' 对 profile '${profileId}' 不可用（不在白名单内，或托管插件已停用）；如需使用请调整 profile skills 配置`,
              403,
              { skillId: input.skillId, profileId, managedByPlugin: skill.managedByPlugin },
            );
          }
          return { text: await skills.readFile(input.skillId, input.path) };
        },
      });

      // assistant Profile 站位：指向 Profile 而非某一具体会话（会话全部删除后
      // 站位仍在，点击可新建会话；不依赖根会话存在）。
      ctx.ui.sidebarItem({
        id: 'assistant',
        label: '个人助理',
        target: `conversation:profile:${DEFAULT_PROFILE_ID}`,
        order: 0,
      });
    },
  };
}
