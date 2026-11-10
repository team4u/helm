/**
 * builtin:profile：常驻角色与技能底座（locked: true）。
 *
 * 职责（记忆已拆分至 builtin:memory，本插件零记忆逻辑）：
 * - 启动自举系统级内置技能 skills/helm-cli（受管覆盖）与默认 assistant
 *   Profile 的托管元数据；
 * - before_turn 注入 profile.system（SYSTEM.md）、profile.skills（可用技能
 *   目录）与 profile.assets-missing（SYSTEM.md 缺失告警）；
 * - 注册 load_skill 工具（Profile 白名单 + 插件启停实时判定）；
 * - 左栏 assistant Profile 站位导航（conversation:profile:assistant，不依赖
 *   某一具体会话存在）。
 */
import { HelmError, isSkillAvailable, type PluginDefinition, type Profile, type SkillSummary } from '@helm/protocol';
import { FileNotFoundError } from '../services/atomic-file.js';
import type { PluginHost } from '../plugins/index.js';
import { DEFAULT_PROFILE_ID, type ProfileService, type SkillService } from '../services/index.js';
import { HELM_CLI_SKILL_ASSET, PROFILE_MANAGED_BY } from './profile/assets.js';

interface ProfilePluginServices {
  profiles: ProfileService;
  skills: SkillService;
  /** 只读当前插件启用状态（技能可用性过滤：插件停用则其托管技能不可用）。
   * 显式工厂依赖而非扩展公共 PluginHost 端口——组合层（app.ts）已有
   * kernel.plugins 可直接满足。 */
  plugins: Pick<PluginHost, 'list'>;
}

export {
  HELM_CLI_SKILL_ID,
  HELM_CLI_SKILL_ASSET,
  PROFILE_MANAGED_BY,
  renderSkillTemplate,
} from './profile/assets.js'

/**
 * 自举默认 assistant Profile 的托管元数据：缺失时显式补写
 * managedByPlugin: 'builtin:profile'（已是其他值或已存在时原样保留，
 * 不做旧数据归一化）；默认 Profile 不存在属内核未初始化异常，如实上抛。
 * 写入经 ProfileService.save 整体保存（其余字段原样透传）。
 */
async function ensureDefaultProfileManaged(profiles: ProfileService): Promise<void> {
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

export function createProfilePlugin({ profiles, skills, plugins }: ProfilePluginServices): PluginDefinition {
  return {
    id: 'builtin:profile',
    name: '角色与技能底座',
    version: '0.1.0',
    locked: true,
    definePlugin(ctx) {
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
       * 读取 SYSTEM.md：文件被外部误删（FileNotFoundError）时按空处理，
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
          if (err instanceof FileNotFoundError) {
            if (!missingNotified.has(profileId)) {
              missingNotified.add(profileId)
              try {
                ctx.host.emitEvent('notification', {
                  type: 'notification',
                  level: 'warning',
                  title: `角色资产文件缺失：${profileId}/SYSTEM.md`,
                  body: `Profile 资产 ${profileId}/SYSTEM.md 不存在（可能被外部误删），本回合按空内容处理；再次写入系统提示词可自愈重建`,
                })
              } catch {
                // 通知失败不阻断回合（事件通道故障由宿主诊断）。
              }
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
        const enabledPluginIds = new Set(plugins.list().filter((p) => p.enabled).map((p) => p.id))
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
          const enabledPluginIds = new Set(plugins.list().filter((p) => p.enabled).map((p) => p.id));
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
        icon: 'sparkles',
        target: `conversation:profile:${DEFAULT_PROFILE_ID}`,
        order: 0,
      });
    },
  };
}
