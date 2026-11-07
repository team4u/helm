import { HelmError, ROOT_CONVERSATION_ID, type PluginDefinition } from '@helm/protocol';
import { FileNotFoundError } from '../services/atomic-file.js';
import type { ProfileService, SkillService } from '../services/index.js';

interface AssistantServices {
  profiles: ProfileService;
  skills: SkillService;
}

/**
 * MEMORY.md 长期记忆上限（字符数）：超过即拒绝写入（update_memory 显式
 * memory_limit_exceeded 400），注入时截断并附显式说明。防线目的：长期记忆
 * 逐回合全量注入系统提示，无上限会让每次调用成本无界增长。
 */
export const MAX_MEMORY_CHARS = 64_000;

/** 截断说明（注入时附在截断内容之后，绝不静默截断）。 */
const MEMORY_TRUNCATION_NOTE = `\n[ helm 提示：MEMORY.md 超过 ${MAX_MEMORY_CHARS} 字符上限，以上为前 ${MAX_MEMORY_CHARS} 字符；请用 update_memory(mode='replace') 整理精简记忆 ]`;

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function createAssistantPlugin({ profiles, skills }: AssistantServices): PluginDefinition {
  return {
    id: 'builtin:assistant',
    name: '个人助理',
    version: '0.1.0',
    locked: true,
    definePlugin(ctx) {
      /**
       * 读取 SYSTEM.md / MEMORY.md，文件被外部误删（FileNotFoundError）时
       * 视为内容为空并发出一次性告警（每回合告警一次，文件恢复即停），
       * 绝不让整个回合 500 崩溃。其余错误（权限/IO 故障）如实上抛。
       */
      let missingFileNotified = false
      const readAssetOrEmpty = async (read: () => Promise<string>, label: string): Promise<string> => {
        try {
          const text = await read()
          missingFileNotified = false
          return text
        } catch (err) {
          if (err instanceof FileNotFoundError) {
            if (!missingFileNotified) {
              missingFileNotified = true
              try {
                ctx.host.emitEvent('notification', {
                  type: 'notification',
                  level: 'warning',
                  title: '助理记忆/系统文件缺失',
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

      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId;
        const [rawSystem, rawMemory, available] = await Promise.all([
          readAssetOrEmpty(() => profiles.getSystem(profileId), `${profileId}/SYSTEM.md`),
          readAssetOrEmpty(() => profiles.getMemory(profileId), `${profileId}/MEMORY.md`),
          skills.list(),
        ]);
        const sections = [...turn.sections];
        if (rawSystem.trim()) sections.push({ id: 'assistant.system', text: rawSystem });
        // 存量超限（外部手改绕过 update_memory）：注入时截断并显式说明，不静默截断。
        const memory =
          rawMemory.length > MAX_MEMORY_CHARS
            ? `${rawMemory.slice(0, MAX_MEMORY_CHARS)}${MEMORY_TRUNCATION_NOTE}`
            : rawMemory
        if (memory.trim()) sections.push({ id: 'assistant.memory', text: `<memory>\n${memory}\n</memory>` });
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
          // 写入前计算合并结果：replace 取 text，append 读现有内容合并；超限显式
          // 拒绝（不写半截文件），提示调用方用 replace 整理精简。
          const nextText =
            input.mode === 'replace'
              ? input.text
              : await (async () => {
                  let current = ''
                  try {
                    current = await profiles.getMemory(profileId)
                  } catch (err) {
                    if (!(err instanceof FileNotFoundError)) throw err
                    // 文件缺失：append 从空开始（与 ProfileService 语义一致）。
                  }
                  return current.endsWith('\n') || current === '' ? current + input.text : current + '\n' + input.text
                })()
          if (nextText.length > MAX_MEMORY_CHARS) {
            throw new HelmError(
              'memory_limit_exceeded',
              `MEMORY.md 写入后达 ${nextText.length} 字符，超过上限 ${MAX_MEMORY_CHARS}；请用 mode='replace' 整理精简记忆后再写入（当前待写内容 ${input.text.length} 字符）`,
              400,
              { profileId, wouldBe: nextText.length, limit: MAX_MEMORY_CHARS, inputLength: input.text.length },
            )
          }
          await profiles.updateMemory(profileId, input.text, input.mode);
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
        async execute(input) {
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
