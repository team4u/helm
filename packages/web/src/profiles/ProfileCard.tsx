import React, { useContext } from 'react'
import type { Profile } from './profile-center-model.js'
import {
  formatProfileLocation,
  formatShortModelName,
  isHerdrProfile,
  isSystemProfile,
  resolveEffectiveProfileModel,
  summarizeProfileActivity,
} from './profile-center-model.js'
import { HelmIcon } from '@helm/plugin-client'
import { HelmStoreContext } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

export interface ProfileCardProps {
  profile: Profile
  selected?: boolean
  onSelect: () => void
  /** Optional: global default model info (defaults to store.defaultModelInfo). */
  defaultModelInfo?: { defaultModel: string; defaultThinkingLevel: string } | null
  /** Optional: bottom-right "Conversation" direct action (defaults to store.openTarget -> #/a/<profileId>). */
  onStartChat?: () => void
}

const ACTIVITY_BADGE_CLASS = {
  working: 'badge badge-ok',
  blocked: 'badge badge-warn',
  error: 'badge badge-err',
  'plugin-disabled': 'badge badge-warn',
  active: 'badge badge-accent',
  idle: 'badge badge-neutral',
} as const

/**
 * Agent profile card:
 * - renders the .primary-card visual spec, compactly showing the profile
 *   name/ID, system lock, activity state, effective model (with thinking
 *   level / global-inheritance markers), node and working directory, skill
 *   count, and the bottom-right direct-conversation button;
 * - keyboard Enter/Space and click open the right detail drawer;
 * - follows the zero-emoji and zero-inline-style rules strictly.
 */
export function ProfileCard({
  profile,
  selected = false,
  onSelect,
  defaultModelInfo,
  onStartChat,
}: ProfileCardProps): React.JSX.Element {
  const store = useContext(HelmStoreContext)
  const { t } = useWebLocale()
  const isSystem = isSystemProfile(profile)
  const isHerdr = isHerdrProfile(profile)
  const effectiveModel = resolveEffectiveProfileModel(
    profile,
    defaultModelInfo !== undefined ? defaultModelInfo : store?.defaultModelInfo,
  )
  const location = formatProfileLocation(profile)
  const activity = summarizeProfileActivity(
    profile,
    store?.conversations ?? [],
    store?.plugins ?? [],
    t,
  )
  const displayName = profile.name || profile.id

  const skillsLabel =
    profile.skills === undefined
      ? t('profiles.card.allSkills')
      : t('profiles.card.skillsCount', { count: profile.skills.length })

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect()
    }
  }

  const handleChatClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (activity.managingPluginDisabled) return
    if (onStartChat) {
      onStartChat()
      return
    }
    store?.openTarget({ kind: 'agent', profileId: profile.id })
  }

  const shortModelName = formatShortModelName(effectiveModel.model)

  const thinkingSuffix = effectiveModel.thinkingLevel
    ? t('profiles.card.thinkingSuffix', { level: effectiveModel.thinkingLevel })
    : ''
  const modelTitle = effectiveModel.model
    ? effectiveModel.source === 'bound'
      ? t('profiles.card.boundModel', { model: effectiveModel.model }) + thinkingSuffix
      : t('profiles.card.inheritModel', { model: effectiveModel.model }) + thinkingSuffix
    : t('profiles.card.followGlobalTitle')

  const locationText = location.cwd
    ? `${location.nodeId} · ${location.cwd}`
    : t('profiles.card.defaultCwd', { nodeId: location.nodeId })

  return (
    <div
      role="button"
      tabIndex={0}
      data-profile-id={profile.id}
      aria-selected={selected}
      className={`primary-card${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
    >
      <div className="primary-card-header">
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={displayName}>
              {displayName}
            </span>
            {isSystem && (
              <span className="primary-card-pill mono" title={t('profiles.card.systemPillTitle')}>
                <HelmIcon name="lock" size={10} />
                <span>{t('profiles.card.systemPill')}</span>
              </span>
            )}
            <span
              className={`${ACTIVITY_BADGE_CLASS[activity.stateKind]} tabular-nums`}
              title={t('profiles.card.activityTitle', { label: activity.stateLabel })}
            >
              {activity.stateLabel}
            </span>
          </div>
          <span className="mono text-subtle break-word">{profile.id}</span>
        </div>
      </div>

      <div className="primary-card-desc" title={profile.description || undefined}>
        {profile.description || t('profiles.card.noDescription')}
      </div>

      <div className="flex-col-xs">
        <div
          className="flex-row primary-card-location text-subtle mono"
          title={t('profiles.card.locationTitle', { location: locationText })}
        >
          <HelmIcon name={location.isRemoteNode ? 'server' : 'laptop'} size={11} />
          <span className="break-word">{locationText}</span>
        </div>

        <div className="primary-card-pills">
          {shortModelName ? (
            <span className="primary-card-pill mono" title={modelTitle}>
              <HelmIcon name="cpu" size={10} />
              <span className="primary-card-pill-label">{shortModelName}</span>
              {effectiveModel.thinkingLevel && (
                <span className="primary-card-pill-suffix">· {effectiveModel.thinkingLevel}</span>
              )}
            </span>
          ) : (
            <span className="primary-card-pill" title={modelTitle}>
              <HelmIcon name="cpu" size={10} />
              <span className="primary-card-pill-label">{t('profiles.card.followGlobalDefault')}</span>
            </span>
          )}
          {effectiveModel.source === 'global' && (
            <span
              className="primary-card-pill"
              title={t('profiles.card.inheritModel', { model: effectiveModel.model ?? '' })}
            >
              <span>{t('profiles.card.globalDefault')}</span>
            </span>
          )}
          <span className="primary-card-pill" title={t('profiles.card.skillsTitle', { label: skillsLabel })}>
            <HelmIcon name="wrench" size={10} />
            <span className="primary-card-pill-label">{skillsLabel}</span>
          </span>
          {isHerdr && (
            <span className="primary-card-pill" title={t('profiles.card.herdrRuntimeTitle')}>
              <HelmIcon name="terminal" size={10} />
              <span>Herdr</span>
            </span>
          )}
        </div>
      </div>

      <div className="primary-card-footer">
        <span className="text-subtle tabular-nums">
          {activity.conversationCount > 0
            ? t('profiles.card.linkedConversations', { count: activity.conversationCount })
            : t('profiles.card.noLinkedConversations')}
        </span>
        {profile.humanSelectable !== false && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={activity.managingPluginDisabled}
            title={
              activity.managingPluginDisabled
                ? t('profiles.card.chatDisabledTitle')
                : t('profiles.card.startConversationTitle', { name: displayName })
            }
            onClick={handleChatClick}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <HelmIcon name="message-square" size={12} />
            <span>{t('profiles.card.conversationAction')}</span>
          </button>
        )}
      </div>
    </div>
  )
}
