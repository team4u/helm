/**
 * Hub 被动升级一次性提示条（总览页顶部，与 HubUpdateCard 同域）：
 * - 数据来自 /api/hub-update/status 的 `upgradedFrom`（Hub 进程级「上次运行版本」对比，
 *   与浏览器无关）；`changelogAvailable` 决定是否给出「查看更新内容」入口；
 * - 「知道了」或打开过 changelog 即在本浏览器记为已读（localStorage 记当前版本），
 *   直到下次版本变化才重新出现——主动一键切换不经过这里（切换完成卡自带引导）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { apiRequest } from '../lib/api.js'

const POLL_MS = 60_000

interface HubUpgradeStatus {
  currentVersion: string | null
  upgradedFrom: string | null
  changelogAvailable: boolean
}

import { markSeenVersion, readSeenVersion } from './hub-changelog-seen.js'

export function HubUpgradedNotice(props: { pollMs?: number }): ReactNode | null {
  const pollMs = props.pollMs ?? POLL_MS
  const { t } = useWebLocale()
  const { setActiveModal } = useStoreActions()
  const [status, setStatus] = useState<HubUpgradeStatus | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void apiRequest<HubUpgradeStatus>('GET', '/api/hub-update/status', undefined, controller.signal)
        .then((next) => {
          setStatus(next)
          if (!controller.signal.aborted) timer = setTimeout(poll, pollMs)
        })
        .catch(() => {
          if (!controller.signal.aborted) timer = setTimeout(poll, pollMs)
        })
    }
    poll()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  if (status === null || status.upgradedFrom === null || status.currentVersion === null) return null
  if (readSeenVersion() === status.currentVersion) return null

  const openChangelog = (): void => {
    setActiveModal({ kind: 'hub-changelog', from: status.upgradedFrom! })
    markSeenVersion(status.currentVersion!)
  }

  return (
    <div className="hub-update-card hub-upgraded-notice" role="status">
      <HelmxIcon name="check-circle" size={14} />
      <span className="hub-update-card-text">
        {t('shell.hubChangelog.upgraded', { from: status.upgradedFrom, version: status.currentVersion })}
      </span>
      {status.changelogAvailable === true ? (
        <button type="button" className="hub-update-card-action" onClick={openChangelog}>
          {t('shell.hubChangelog.viewChanges')}
        </button>
      ) : null}
      <button
        type="button"
        className="hub-update-card-action hub-update-card-dismiss"
        onClick={() => markSeenVersion(status.currentVersion!)}
      >
        {t('shell.hubChangelog.dismiss')}
      </button>
    </div>
  )
}
