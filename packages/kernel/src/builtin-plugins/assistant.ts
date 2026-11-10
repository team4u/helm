import { ROOT_CONVERSATION_ID, HelmError, isSkillAvailable, type PluginDefinition, type Profile, type SkillSummary } from '@helm/protocol';
import { FileNotFoundError } from '../services/atomic-file.js';
import type { PluginHost } from '../plugins/index.js';
import { DEFAULT_PROFILE_ID, MAX_MEMORY_CHARS, type ProfileService, type SkillService } from '../services/index.js';
import { HELM_CLI_SKILL_ASSET } from './assistant/assets.js';

interface AssistantServices {
  profiles: ProfileService;
  skills: SkillService;
  /** 只读当前插件启用状态（技能可用性过滤：插件停用则其托管技能不可用）。
   * 显式工厂依赖而非扩展公共 PluginHost 端口——组合层（app.ts）已有
   * kernel.plugins 可直接满足。 */
  plugins: Pick<PluginHost, 'list'>;
}

/**
 * MEMORY.md 长期记忆上限（字符数）：单一事实来源在 services/profiles-skills.ts
 * （所有写入路径在文件锁内统一强制）；此处 re-export 供插件层与测试引用。
 * 超过即拒绝写入（update_memory 显式 memory_limit_exceeded 400），注入时截断
 * 并附显式说明。防线目的：长期记忆逐回合全量注入系统提示，无上限会让每次
 * 调用成本无界增长。
 */
export { MAX_MEMORY_CHARS };
export {
  ASSISTANT_MANAGED_BY,
  HELM_CLI_SKILL_ID,
  HELM_CLI_SKILL_ASSET,
} from './assistant/assets.js';

/** 截断说明（注入时附在截断内容之后，绝不静默截断）。 */
const MEMORY_TRUNCATION_NOTE = `\n[ helm 提示：MEMORY.md 超过 ${MAX_MEMORY_CHARS} 字符上限，以上为前 ${MAX_MEMORY_CHARS} 字符；请用 update_memory(mode='replace') 整理精简记忆 ]`;

/**
 * 自举默认 assistant Profile 的托管元数据：缺失时显式补写
 * managedByPlugin: 'builtin:assistant'（已是其他值或已存在时原样保留，
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
  const next: Profile = { ...existing, managedByPlugin: 'builtin:assistant' };
  await profiles.save(next);
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function createAssistantPlugin({ profiles, skills, plugins }: AssistantServices): PluginDefinition {
  return {
    id: 'builtin:assistant',
    name: '个人助理',
    version: '0.1.0',
    locked: true,
    definePlugin(ctx) {
      // 启动时同步系统级内置技能 skills/helm-cli/（Layer 1 + Layer 2）：
      // 受管系统资产以源码版本为准逐文件覆盖，缺失补齐；常规接口写入被拒。
      // 同时自举默认 assistant Profile 的托管元数据：缺失时显式补写
      // managedByPlugin（ensureDefault 不做旧数据归一化，由本插件自举声明）。
      ctx.service({
        id: 'assistant-skills',
        async start() {
          await skills.ensureSkill(HELM_CLI_SKILL_ASSET);
          await ensureDefaultProfileManaged(profiles);
        },
        async stop() {},
      });

      /**
       * 读取 SYSTEM.md / MEMORY.md：文件被外部误删（FileNotFoundError）时按空
       * 处理，但绝不沉默改变人格——① 向人类发一次性告警（每文件独立去重，
       * 文件恢复即停、再次缺失可重新告警）；② 向模型注入显式的
       * <profile_assets_missing> 说明节，告知本轮人格/记忆资产缺失及其后果。
       * 其余错误（权限/IO 故障）如实上抛，绝不吞。
       */
      const missingNotified: Record<'system' | 'memory', boolean> = { system: false, memory: false }
      const readAssetOrEmpty = async (
        read: () => Promise<string>,
        which: 'system' | 'memory',
        label: string,
      ): Promise<string> => {
        try {
          const text = await read()
          missingNotified[which] = false // 恢复即停；下次再缺失可重新告警
          return text
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            if (!missingNotified[which]) {
              missingNotified[which] = true
              try {
                ctx.host.emitEvent('notification', {
                  type: 'notification',
                  level: 'warning',
                  title: `助理资产文件缺失：${label}`,
                  body: `Profile 资产 ${label} 文件不存在（可能被外部误删），本回合按空内容处理；下次 update_memory / update_system 写入可自愈重建`,
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
        const [rawSystem, rawMemory, available] = await Promise.all([
          readAssetOrEmpty(() => profiles.getSystem(profileId), 'system', `${profileId}/SYSTEM.md`),
          readAssetOrEmpty(() => profiles.getMemory(profileId), 'memory', `${profileId}/MEMORY.md`),
          listAvailableSkills(profileId),
        ]);
        const sections = [...turn.sections];
        if (rawSystem.trim()) sections.push({ id: 'assistant.system', text: rawSystem });
        // 存量超限（外部手改绕过写入防线）：注入时截断并显式说明，不静默截断、
        // 不修改源文件（只对注入副本切片）。
        const memory =
          rawMemory.length > MAX_MEMORY_CHARS
            ? `${rawMemory.slice(0, MAX_MEMORY_CHARS)}${MEMORY_TRUNCATION_NOTE}`
            : rawMemory
        if (memory.trim()) sections.push({ id: 'assistant.memory', text: `<memory>\n${memory}\n</memory>` });
        // 资产缺失必须向模型显式告知（不能沉默换人格）：列出缺失文件与后果。
        const missing: string[] = []
        if (!rawSystem.trim()) missing.push(`SYSTEM.md（人格/职责定义）`)
        if (!rawMemory.trim()) missing.push(`MEMORY.md（长期记忆）`)
        if (missing.length > 0) {
          sections.push({
            id: 'assistant.assets-missing',
            text: [
              '<profile_assets_missing>',
              `本回合缺少 Profile '${profileId}' 的${missing.join('与')}（文件不存在或为空）。`,
              '你当前没有该 Profile 的人格设定与长期记忆：请告知用户资产缺失，谨慎回答，不要假装拥有既往记忆或特定人格；资产写入后自动恢复。',
              '</profile_assets_missing>',
            ].join('\n'),
          })
        }
        if (available.length) {
          const catalog = available.map((skill) =>
            `<skill id="${escapeXml(skill.id)}"><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description ?? '')}</description><references>${skill.references.map(escapeXml).join(', ')}</references></skill>`,
          ).join('\n');
          sections.push({
            id: 'assistant.skills',
            text: `<available_skills>\n${catalog}\n</available_skills>\nUse load_skill to read a skill before applying it. Read reference files only as needed.`,
          });
        }
        return { action: 'transform', value: { ...turn, sections } };
      });

      ctx.tool<{ text: string; mode: 'append' | 'replace' }>({
        name: 'update_memory',
        description: '更新当前会话 Profile 的 MEMORY.md。append 追加内容，replace 替换全文（超过 64000 字符需先 replace 精简）。',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
          required: ['text', 'mode'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const conversation = ctx.host.getConversation(context.conversationId);
          const profileId = conversation.profileId;
          // 大小防线唯一权威点在 ProfileService.updateMemory 文件锁内（合并后
          // 检查）：跨会话同 Profile 并发 append 不可能叠加突破上限；超限抛
          // memory_limit_exceeded 400（提示 replace 精简），不写半截文件。
          await profiles.updateMemory(profileId, input.text, input.mode, { maxChars: MAX_MEMORY_CHARS });
          return { updated: true, profileId };
        },
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

      ctx.ui.sidebarItem({
        id: 'assistant',
        label: '个人助理',
        icon: 'sparkles',
        target: `conversation:${ROOT_CONVERSATION_ID}`,
        order: 0,
      });
    },
  };
}
