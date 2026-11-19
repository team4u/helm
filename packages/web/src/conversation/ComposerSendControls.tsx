import type { WhenBusy } from '@helmx/protocol/browser'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu.js'
import { Tooltip } from '../ui/Tooltip.js'
import { useIsMobile, type SessionEnvBlocker } from './composer-model.js'

// ---------------------------------------------------------------------------
// Send / stop controls (extracted from Composer.tsx): idle send, busy stop and
// the steer/queue split. Desktop keeps the split dropdown (with .kbd-hint
// badges); on mobile with input present while busy, two explicit side-by-side
// buttons [steer] and [queue] render instead of a shortcut to memorize.
// ---------------------------------------------------------------------------

export interface ComposerSendControlsProps {
  working: boolean
  editingEntryId: number | null
  sending: boolean
  uploading: number
  envBlocker: SessionEnvBlocker
  text: string
  isMobile?: boolean
  send: (busyMode?: WhenBusy, strict?: boolean) => Promise<void>
  abortTurn: () => Promise<void>
}

export function ComposerSendControls({
  working,
  editingEntryId,
  sending,
  uploading,
  envBlocker,
  text,
  isMobile,
  send,
  abortTurn,
}: ComposerSendControlsProps) {
  const { t } = useWebLocale()
  const detectedMobile = useIsMobile(680)
  const mobile = isMobile ?? detectedMobile
  const busyDisabled = sending || uploading > 0 || envBlocker.blocked

  return (
    <span className="composer-toolbar-right">
      {!working || editingEntryId !== null ? (
        <button
          type="button"
          className="btn btn-sm btn-primary btn-pill btn-send"
          disabled={sending || uploading > 0 || envBlocker.blocked || text.trim() === ''}
          onClick={() => void send()}
          title={editingEntryId !== null
            ? working
              ? t('composer.sendControls.updateWorkingTitle')
              : t('composer.sendControls.updateTitle')
            : envBlocker.blocked
              ? envBlocker.reason ?? t('composer.env.saveOrCancelFirst')
              : t('composer.sendControls.sendTitle')}
          aria-label={editingEntryId !== null ? t('composer.sendControls.updateShort') : uploading > 0 ? t('composer.sendControls.uploading', { count: uploading }) : t('composer.sendControls.send')}
        >
          <HelmxIcon name={sending || uploading > 0 ? 'loader' : 'arrow-up'} size={18} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
        </button>
      ) : text.trim() === '' ? (
        <Tooltip content={t('composer.sendControls.stopExecution')} side="top">
          <button
            type="button"
            className="btn btn-sm btn-danger btn-pill btn-send composer-abort-button"
            onClick={() => void abortTurn()}
            title={t('composer.sendControls.stopExecution')}
            aria-label={t('composer.sendControls.stopExecution')}
          >
            <HelmxIcon name="square" size={14} />
          </button>
        </Tooltip>
      ) : mobile ? (
        <div className="composer-busy-mobile-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary composer-mobile-steer-btn composer-steer-action"
            disabled={busyDisabled}
            onClick={() => void send('steer')}
            title={t('composer.sendControls.steerHint')}
            aria-label={uploading > 0 ? t('composer.sendControls.uploading', { count: uploading }) : t('composer.sendControls.steer')}
          >
            <HelmxIcon
              name={sending || uploading > 0 ? 'loader' : 'corner-down-right'}
              size={13}
              className={sending || uploading > 0 ? 'spin-slow' : undefined}
            />
            <span>{t('composer.sendControls.steerShort')}</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary composer-mobile-queue-btn"
            disabled={busyDisabled}
            onClick={() => void send('followUp')}
            title={t('composer.sendControls.queueHint')}
            aria-label={t('composer.sendControls.queueSend')}
          >
            <HelmxIcon name="clock" size={13} />
            <span>{t('composer.sendControls.queue')}</span>
          </button>
        </div>
      ) : (
        <DropdownMenuRoot>
          <div className="composer-split-send">
            <button
              type="button"
              className="composer-split-main composer-steer-action"
              disabled={busyDisabled}
              onClick={() => void send('steer')}
              title={t('composer.sendControls.steerHintEnter')}
              aria-label={uploading > 0 ? t('composer.sendControls.uploading', { count: uploading }) : editingEntryId !== null ? t('composer.sendControls.updateShort') : t('composer.sendControls.steer')}
            >
              <HelmxIcon
                name={sending || uploading > 0 ? 'loader' : 'corner-down-right'}
                size={14}
                className={sending || uploading > 0 ? 'spin-slow' : undefined}
              />
              <span className="composer-action-label">{editingEntryId !== null ? t('composer.sendControls.updateLabel') : t('composer.sendControls.insertLabel')}</span>
            </button>
            <div className="composer-split-divider" />
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="composer-split-trigger"
                disabled={busyDisabled}
                aria-label={t('composer.sendControls.chooseStrategy')}
                title={t('composer.sendControls.chooseStrategyTitle')}
              >
                <HelmxIcon name="chevron-down" size={12} />
              </button>
            </DropdownMenuTrigger>
          </div>
          <DropdownMenuContent portalled align="end" side="top" sideOffset={6} className="composer-busy-dropdown-content">
            <DropdownMenuItem
              className="composer-busy-menu-item"
              onClick={() => void send('steer')}
            >
              <HelmxIcon name="corner-down-right" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">{t('composer.sendControls.steer')}</div>
                <div className="composer-busy-menu-desc">{t('composer.sendControls.steerHint')}</div>
              </div>
              <span className="composer-busy-menu-kbd kbd-hint">Enter</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="composer-busy-menu-item composer-queue-button"
              onClick={() => void send('followUp')}
              title={t('composer.sendControls.queueHintKbd')}
              aria-label={t('composer.sendControls.queueSend')}
            >
              <HelmxIcon name="clock" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">{t('composer.sendControls.queueSend')}</div>
                <div className="composer-busy-menu-desc">{t('composer.sendControls.queueHint')}</div>
              </div>
              <span className="composer-busy-menu-kbd kbd-hint">⌘/Ctrl+Enter</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              className="composer-busy-menu-item"
              onClick={() => void abortTurn()}
              title={t('composer.sendControls.stopExecution')}
              aria-label={t('composer.sendControls.stopExecution')}
            >
              <HelmxIcon name="square" size={13} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">{t('composer.sendControls.stopMenuTitle')}</div>
                <div className="composer-busy-menu-desc">{t('composer.sendControls.abortNow')}</div>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      )}
    </span>
  )
}
