/**
 * Hub 更新卡片（总览页顶部）：消费 `/api/hub-update/*` 产品路由。
 *
 * - 仅在存在就绪更新（readyVersion）时渲染，平时零占地（unmanaged 的 docker/dev Hub
 *   返回 active:false，同样不渲染）；
 * - 「立即切换」= POST apply（默认尊重忙时门控；hub_busy 时如实展示计数并提供
 *   「仍要切换」强制路径）；202 后进入切换中状态，轮询 status 直到新版本上线，
 *   再提示刷新页面加载新前端资产；
 * - 展示层不猜测：lastError / blocked / cooldown 原文透出，绝不伪造成功。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HelmxIcon } from '@helmx/plugin-client'
import { apiRequest, ApiClientError } from '../lib/api.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

interface HubUpdateStatus {
  active: boolean
  currentVersion: string | null
  readyVersion: string | null
  lastError: string | null
  blocked: { version: string; reason: string; at: string } | null
}

type Phase = 'idle' | 'switching' | 'switched' | 'error'

const POLL_MS = 60_000
const SWITCH_POLL_MS = 2_000
const SWITCH_TIMEOUT_MS = 180_000

async function fetchStatus(signal: AbortSignal): Promise<HubUpdateStatus | null> {
  try {
    return await apiRequest<HubUpdateStatus>('GET', '/api/hub-update/status', undefined, signal)
  } catch {
    return null // transient network/401 — the next poll retries; no fabricated state
  }
}

export function HubUpdateCard(props: { pollMs?: number }): ReactNode | null {
  const pollMs = props.pollMs ?? POLL_MS
  const { t } = useWebLocale()
  const [status, setStatus] = useState<HubUpdateStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null)
  const [busyCounts, setBusyCounts] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const targetRef = useRef<string | null>(null)
  const startedAtRef = useRef<number>(0)

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void fetchStatus(controller.signal).then((next) => {
        if (next !== null) setStatus(next)
        if (!controller.signal.aborted) timer = setTimeout(poll, pollMs)
      })
    }
    poll()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  // Switching watch: poll until the new version serves (or the budget expires honestly).
  useEffect(() => {
    if (phase !== 'switching') return
    const target = targetRef.current
    if (target === null) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      void fetchStatus(controller.signal).then((next) => {
        if (controller.signal.aborted || next === null) return
        setStatus(next)
        if (next.currentVersion === target && next.readyVersion !== target) {
          setPhase('switched')
          return
        }
        if (Date.now() - startedAtRef.current > SWITCH_TIMEOUT_MS) {
          setPhase('error')
          setPhaseDetail(t('shell.hubUpdate.switchTimeout', { version: target }))
          return
        }
        timer = setTimeout(poll, SWITCH_POLL_MS)
      })
    }
    timer = setTimeout(poll, SWITCH_POLL_MS)
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [phase, t])

  const apply = useCallback(
    async (force: boolean): Promise<void> => {
      setApplying(true)
      setBusyCounts(null)
      try {
        const result = await apiRequest<{ ok: boolean; switching: boolean; targetVersion: string }>(
          'POST',
          '/api/hub-update/apply',
          force ? { force: true } : {},
        )
        if (result.switching === true) {
          targetRef.current = result.targetVersion
          startedAtRef.current = Date.now()
          setPhase('switching')
        }
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 409) {
          const code = error.code
          if (code === 'hub_busy') {
            const counts = ((error.details ?? {}) as { counts?: Record<string, number> }).counts ?? {}
            const parts = Object.entries(counts)
              .filter(([, value]) => value > 0)
              .map(([key, value]) => `${key}=${value}`)
              .join(' ')
            setBusyCounts(parts !== '' ? parts : 'busy')
          } else {
            setPhase('error')
            setPhaseDetail(error.message)
          }
        } else {
          setPhase('error')
          setPhaseDetail(error instanceof Error ? error.message : String(error))
        }
      } finally {
        setApplying(false)
      }
    },
    [],
  )

  if (status === null || status.readyVersion === null || status.active !== true) return null
  if (phase === 'switched') {
    return (
      <div className="hub-update-card hub-update-card-switched" role="status">
        <HelmxIcon name="check" size={14} />
        <span className="hub-update-card-text">{t('shell.hubUpdate.switched', { version: status.readyVersion })}</span>
        <button type="button" className="hub-update-card-action" onClick={() => window.location.reload()}>
          {t('shell.hubUpdate.reload')}
        </button>
      </div>
    )
  }
  if (phase === 'switching') {
    return (
      <div className="hub-update-card hub-update-card-switching" role="status">
        <HelmxIcon name="loader" size={14} />
        <span className="hub-update-card-text">{t('shell.hubUpdate.switching', { version: targetRef.current ?? '' })}</span>
      </div>
    )
  }
  return (
    <div className="hub-update-card" role="status">
      <HelmxIcon name="download" size={14} />
      <span className="hub-update-card-text">
        {t('shell.hubUpdate.ready', {
          current: status.currentVersion ?? '?',
          version: status.readyVersion,
        })}
      </span>
      {phase === 'error' && phaseDetail !== null ? (
        <span className="hub-update-card-error">{phaseDetail}</span>
      ) : null}
      {busyCounts !== null ? (
        <span className="hub-update-card-busy">{t('shell.hubUpdate.busy', { counts: busyCounts })}</span>
      ) : null}
      {busyCounts !== null ? (
        <button type="button" className="hub-update-card-action" disabled={applying} onClick={() => void apply(true)}>
          {t('shell.hubUpdate.forceApply')}
        </button>
      ) : (
        <button type="button" className="hub-update-card-action" disabled={applying} onClick={() => void apply(false)}>
          {t('shell.hubUpdate.apply')}
        </button>
      )}
    </div>
  )
}
