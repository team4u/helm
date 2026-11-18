/**
 * builtin:profile: the resident roles-and-skills foundation (locked: true).
 *
 * Responsibilities (memory split to builtin:memory; this plugin has zero memory logic):
 * - Bootstrap the system-level built-in skill skills/helm-cli (managed overwrite) and the default
 *   assistant Profile's managed metadata at startup;
 * - before_turn injects profile.system (SYSTEM.md), profile.skills (the available skill
 *   catalog), profile.assets-missing (a missing-SYSTEM.md warning), and profile.agents /
 *   profile.agents-unavailable (the workspace AGENTS.md project conventions; read failures or a
 *   remote node going offline are stated explicitly, never silently degraded);
 * - a low-priority before_turn (running after the default-priority tool-stripping hooks) injects
 *   profile.catalog per the turn's actual turn.tools (the cross-Profile collaboration catalog;
 *   leaf subagents whose dispatch tools were stripped get no injection, and neither do turns without dispatch tools when builtin:workflow is disabled);
 * - registers the load_skill tool (Profile whitelist + live plugin enablement) and the
 *   idempotent list_mentionable action (the @ completion source, auto-mapped to HTTP / helm
 *   list_mentionable CLI）；
 * - the left-sidebar assistant Profile standing navigation (conversation:profile:assistant, not
 *   dependent on any particular conversation existing).
 */
import { HelmError, escapeXml, isSkillAvailable, type HelmHostProfilesPort, type PluginDefinition, type Profile, type SkillSummary } from '@helm/protocol';
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
import { computeAgentsMdSection } from './profile/agents-md.js';

const DEFAULT_PROFILE_ID = 'assistant';

export {
  HELM_CLI_SKILL_ID,
  HELM_CLI_SKILL_ASSET,
  PROFILE_MANAGED_BY,
  renderSkillTemplate,
} from './profile/assets.js'
export {
  AGENTS_MD_FILENAME,
  MAX_AGENTS_MD_CHARS,
  computeAgentsMdSection,
  type AgentsMdHostPort,
  type AgentsMdInjection,
} from './profile/agents-md.js'
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
 * Bootstrap the default assistant Profile's managed metadata: explicitly write
 * managedByPlugin: 'builtin:profile' when missing (kept as-is when it holds another value
 * or already exists -- no old-data normalization); a missing default Profile is a kernel
 * not-initialized anomaly and propagates honestly.
 */
async function ensureDefaultProfileManaged(profiles: HelmHostProfilesPort): Promise<void> {
  const existing = await profiles.get(DEFAULT_PROFILE_ID);
  if (existing === undefined) {
    throw new Error(
      `default profile '${DEFAULT_PROFILE_ID}' does not exist (the kernel's ensureDefault should run before plugin startup)`,
    );
  }
  if (existing.managedByPlugin !== undefined) return;
  const next: Profile = { ...existing, managedByPlugin: PROFILE_MANAGED_BY };
  await profiles.save(next);
}

/** Catalog injection hook priority: below the default 0, ensuring it runs after the default-priority
 * tool-stripping hooks (e.g. routing-mode convergence) and decides injection by the then-actual turn.tools. */
const CATALOG_HOOK_PRIORITY = -100;

export function createProfilePlugin(): PluginDefinition {
  return {
    id: 'builtin:profile',
    name: { en: 'Roles & Skills Foundation', 'zh-CN': '角色与技能基座' },
    description: {
      en: 'Resident foundation: injects SYSTEM.md and the available skill catalog per the conversation Profile, providing the load_skill tool and the default assistant role.',
      'zh-CN': '常驻基座：按会话 Profile 注入 SYSTEM.md 与可用技能目录，提供 load_skill 工具与默认助手角色。',
    },
    icon: 'bot',
    version: '0.1.0',
    locked: true,
    definePlugin(ctx) {
      const { profiles, skills } = ctx.host;
      // Sync the system-level built-in skill skills/helm-cli/ (Layer 1 + Layer 2) at startup:
      // managed system assets are overwritten file-by-file per the source version, and missing files are
      // backfilled; writes through the regular interface are rejected.
      // managedByPlugin (ensureDefault does not normalize; this plugin bootstraps the declaration).
      ctx.service({
        id: 'profile-skills',
        async start() {
          await skills.ensureSkill(HELM_CLI_SKILL_ASSET);
          await ensureDefaultProfileManaged(profiles);
        },
        async stop() {},
      });

      /**
       * Read SYSTEM.md: when externally deleted by mistake (not_found), treat it as empty,
       * but never silently change the persona -- (1) send a one-time warning to the human
       * (deduped per profileId; stops once restored, can warn again if missing later);
       * (2) inject an explicit <profile_assets_missing> section for the model stating that this
       * turn's persona assets are missing and the consequence. Other errors (permission/IO faults) propagate honestly, never swallowed.
       */
      const missingNotified = new Set<string>()
      const readSystemOrEmpty = async (
        profileId: string,
      ): Promise<string> => {
        try {
          const text = await profiles.getSystem(profileId)
          missingNotified.delete(profileId) // stop once restored; can warn again if missing later
          return text
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') {
            if (!missingNotified.has(profileId)) {
              await ctx.host.emitEvent('notification', {
                type: 'notification',
                level: 'warning',
                title: `Profile asset file missing: ${profileId}/SYSTEM.md`,
                body: `Profile asset ${profileId}/SYSTEM.md does not exist (possibly deleted externally); this turn proceeds with empty content; writing the system prompt again self-heals it`,
              })
              missingNotified.add(profileId)
            }
            return ''
          }
          throw err
        }
      }

      /**
       * Read the current Profile's real config + plugin enablement, and filter the skill catalog
       * by the shared isSkillAvailable rule (Profile.skills defaults to all, [] disables all, a
       * non-empty whitelist filters; a disabled plugin's managed skills are unavailable). Re-read
       * every turn -- runtime Profile edits or plugin toggles take effect on the next turn. A missing Profile is a config anomaly and errors explicitly.
       */
      const listAvailableSkills = async (profileId: string): Promise<SkillSummary[]> => {
        const profile = await profiles.get(profileId)
        if (profile === undefined) {
          throw new HelmError('profile_not_found', `conversation-bound profile '${profileId}' does not exist (the skill catalog cannot be filtered by Profile)`, 500, { profileId })
        }
        const enabledPluginIds = new Set(ctx.host.listPlugins().filter((p) => p.enabled).map((p) => p.id))
        const all = await skills.list()
        return all.filter((skill) => isSkillAvailable(skill, profile, enabledPluginIds))
      }

      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId;
        // The workspace AGENTS.md (project-level conventions) reads in parallel with persona/skills:
        // re-read live every turn; file edits take effect on the next turn; the explicit-explanation
        // policy for read failures or a remote node going offline lives in profile/agents-md.ts
        const [rawSystem, available, agentsMd] = await Promise.all([
          readSystemOrEmpty(profileId),
          listAvailableSkills(profileId),
          computeAgentsMdSection(ctx.host, turn.conversation.nodeId, turn.conversation.cwd),
        ]);
        const sections = [...turn.sections];
        if (rawSystem.trim()) sections.push({ id: 'profile.system', text: rawSystem });
        // Asset absence must be told to the model explicitly (never a silent persona swap): SYSTEM.md missing/empty.
        if (!rawSystem.trim()) {
          sections.push({
            id: 'profile.assets-missing',
            text: [
              '<profile_assets_missing>',
              `This turn lacks the SYSTEM.md of Profile '${profileId}' (file missing or empty).`,
              'You currently have no persona for this Profile: tell the user the asset is missing, answer carefully, and do not pretend to have a specific persona; it recovers automatically once the asset is written.',
              '</profile_assets_missing>',
            ].join('\n'),
          });
        }
        // The workspace project conventions are injected right after persona assets, before the skill catalog.
        if (agentsMd.kind === 'section') sections.push({ id: agentsMd.id, text: agentsMd.text });
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
       * Read candidate Profiles' SYSTEM.md to extract one-line summaries: a missing file
       * (not_found) only affects that candidate's summary field (undefined, no fabricated bio),
       * without warning -- the cognitive-absence warning discipline applies only to the current
       * conversation's bound-Profile persona assets (see readSystemOrEmpty); a candidate missing
       * SYSTEM.md is a configuration state and does not widen the warning surface. Other IO /
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
       * Unified computation of the collaboration catalog (the completion action and the
       * before_turn injection share the same fact source):
       * - exclude self / humanSelectable:false / managed plugins disabled / runtime.kind
       *   without an enabled profile.runtime UI contribution (see catalog.ts rules);
       * - decide purely by whether the turn still has dispatch tools: builtin:workflow strips
       *   subagent/SubagentWorkflow for managed subagents at the depth cap (orchestration leaves)
       *   at a higher-priority hook, so this naturally returns empty -- no blanket exclusion by
       * parentConversationId (fork / SuperAgent workers also have parent chains yet should keep
       *   full collaboration ability; level-1 subagents keep dispatch tools by default and also get the catalog);
       * - re-read the Profile catalog and plugin state live on every call (edits/toggles take effect next turn).
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
       * The dispatch tool names actually available this turn (only counting existing declarations in turn.tools, avoiding phantom tools).
       * The catalog injection hook runs at a below-default priority (see CATALOG_HOOK_PRIORITY),
       * so what it sees is the final tool list converged by the default-priority hooks (e.g.
       * routing mode stripping subagent) -- the completion action falls back to a separate judgment when it cannot see the turn's tools (see the action implementation).
       */
      const dispatchToolNames = (tools: readonly { name: string }[]): string[] =>
        ['subagent', 'SubagentWorkflow'].filter((name) => tools.some((t) => t.name === name))

      ctx.hook.onBeforeTurn(
        async (turn) => {
          // Turns without available dispatch tools get no catalog (avoiding teaching calls to
          // nonexistent tools; depth-capped leaf subagents had their dispatch tools stripped by the
          // builtin:workflow hook, converging naturally here). The post-convergence tools are
          // read-only here; no exclusion by parentConversationId (fork / SuperAgent workers also
          // have parent chains and should keep collaboration ability; level-1 subagents keep dispatch tools by default and also get the catalog).
          const tools = dispatchToolNames(turn.tools)
          if (tools.length === 0) return { action: 'continue' }
          const entries = await computeCatalog(turn.conversation.profileId)
          if (entries.length === 0) return { action: 'continue' }
          const sections = [...turn.sections, { id: 'profile.catalog', text: renderProfileCatalogSection(entries, { dispatchToolNames: tools }) }]
          return { action: 'transform', value: { ...turn, sections } }
        },
        { priority: CATALOG_HOOK_PRIORITY },
      )

      // ---- @ completion action: list_mentionable (idempotent read-only; auto-mapped to HTTP / CLI) ----
      ctx.action<
        { query?: string; conversationId?: number; profileId?: string },
        { items: Array<{ id: string; label: string; insertText: string; hint: string; icon: string }> }
      >({
        id: 'list_mentionable',
        description: 'List Profile candidates that the current conversation or a standby role can @ mention for collaboration (the @ completion source; --current / --conversation-id / --profile-id pick the context)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Filter prefix (empty by default)' },
            conversationId: { type: 'number', description: 'Explicit target conversation (used when the CLI has no calling context; Web conversation completion omits it and defers to the server context)' },
            profileId: { type: 'string', minLength: 1, description: 'Explicit target role (used with no conversation context, e.g. standby draft mode; with conversation context, the server conversation\'s role wins)' },
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
        exposeToPrompt: false,
        idempotent: true,
        async handler(input, context) {
          // Identity adjudication: the calling-context conversation (the outer conversationId
          // injected by Web / --current) is the only trusted source; without it, accept an explicit
          // input.conversationId or input.profileId in that order (standby draft mode), and it must
          // really exist. All three missing -> explicit validation_error; never guess a default conversation or role.
          let targetProfileId: string
          if (context.conversationId !== undefined) {
            targetProfileId = ctx.host.getConversation(context.conversationId).profileId
          } else if (input.conversationId !== undefined) {
            targetProfileId = ctx.host.getConversation(input.conversationId).profileId
          } else if (input.profileId !== undefined) {
            const profile = await profiles.get(input.profileId)
            if (profile === undefined) {
              throw new HelmError('not_found', `profile does not exist: ${input.profileId}`, 404, { profileId: input.profileId })
            }
            targetProfileId = profile.id
          } else {
            throw new HelmError(
              'validation_error',
              'Missing conversation or role context: Web completion carries it automatically; in the CLI, use --current or specify --conversation-id / --profile-id explicitly',
              400,
            )
          }
          const query = (input.query ?? '').trim().toLowerCase()
          // Completion has no turn tool list: judge candidates by plugin availability (never
          // claiming to know the final tool list -- turn-level convergence happens separately at
          // catalog injection, both sharing the same rules; turn-level stripping of nested subagents
          const entries = await computeCatalog(targetProfileId)
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

      // ---- @ completion source declaration (reusing the host's generic completion rendering; label only orders plugin sources) ----
      ctx.ui.composerCompleter({
        id: 'profile-mentions',
        label: { en: 'Mention roles', 'zh-CN': '点名角色' },
        trigger: '@',
        priority: 100,
        source: { kind: 'action', actionId: 'list_mentionable' },
      })

      ctx.tool<{ skillId: string; path?: string }>({
        name: 'load_skill',
        description: 'Read a skill\'s SKILL.md, or reference files inside the skill directory on demand. Example path: references/guide.md.',
        inputSchema: {
          type: 'object',
          properties: { skillId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } },
          required: ['skillId'],
          additionalProperties: false,
        },
        async execute(input, context) {
          // Judge live by the conversation's current Profile whitelist and plugin enablement (same
          // rule as catalog injection): outside the Profile whitelist or managed plugin disabled ->
          // 403 skill_not_available; skill nonexistent -> 404 not_found (no content leakage). Path
          // safety checks are preserved as-is in SkillService.readFile (traversal/absolute
          // paths/symlinks all rejected).
          const conversation = ctx.host.getConversation(context.conversationId);
          const profileId = conversation.profileId;
          const profile = await profiles.get(profileId);
          if (profile === undefined) {
            throw new HelmError('profile_not_found', `conversation-bound profile '${profileId}' does not exist; cannot determine skill availability`, 500, { profileId });
          }
          const enabledPluginIds = new Set(ctx.host.listPlugins().filter((p) => p.enabled).map((p) => p.id));
          const skill = (await skills.list()).find((s) => s.id === input.skillId);
          if (skill === undefined) {
            throw new HelmError('not_found', `skill does not exist: ${input.skillId}`, 404, { skillId: input.skillId });
          }
          if (!isSkillAvailable(skill, profile, enabledPluginIds)) {
            throw new HelmError(
              'skill_not_available',
              `skill '${input.skillId}' is unavailable for profile '${profileId}' (not whitelisted, or its managing plugin is disabled); adjust the profile skills config to use it`,
              403,
              { skillId: input.skillId, profileId, managedByPlugin: skill.managedByPlugin },
            );
          }
          return { text: await skills.readFile(input.skillId, input.path) };
        },
      });

      // assistant Profile standing entry: points at the Profile rather than any particular
      // conversation (the entry survives even with all conversations deleted; clicking creates a
      ctx.ui.sidebarItem({
        id: 'assistant',
        label: { en: 'Personal Assistant', 'zh-CN': '个人助理' },
        target: `conversation:profile:${DEFAULT_PROFILE_ID}`,
        order: 0,
      });
    },
  };
}
