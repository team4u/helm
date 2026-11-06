import { ROOT_CONVERSATION_ID, type PluginDefinition } from '@helm/protocol';
import type { ProfileService, SkillService } from '../services/index.js';

interface AssistantServices {
  profiles: ProfileService;
  skills: SkillService;
}

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
      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId;
        const [system, memory, available] = await Promise.all([
          profiles.getSystem(profileId),
          profiles.getMemory(profileId),
          skills.list(),
        ]);
        const sections = [...turn.sections];
        if (system.trim()) sections.push({ id: 'assistant.system', text: system });
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
        description: '更新当前会话 Profile 的 MEMORY.md。append 追加内容，replace 替换全文。',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
          required: ['text', 'mode'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const conversation = ctx.host.getConversation(context.conversationId);
          await profiles.updateMemory(conversation.profileId, input.text, input.mode);
          return { updated: true, profileId: conversation.profileId };
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
      });
    },
  };
}
