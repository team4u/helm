import type { WhenBusy } from '@helm/protocol/browser'
import { HelmIcon } from '@helm/plugin-client'
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
// 发送 / 停止控件（自 Composer.tsx 拆出）：空闲发送、正忙停止与插话/排队分流。
// 桌面端保留分体下拉（带 .kbd-hint 角标）；移动端正忙有输入时直接并排显式
// 呈现 [插话]（steer）与 [排队]（followUp）两个独立按钮，无需记忆快捷键。
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
              ? 'Update and regenerate (overwrites this message and everything after it and stops the current execution) (Enter)'
              : 'Update and regenerate (overwrites this message and everything after it) (Enter)'
            : envBlocker.blocked
              ? envBlocker.reason ?? 'Save or cancel the starting environment changes first'
              : 'Send (Enter); Shift+Enter for a newline'}
          aria-label={editingEntryId !== null ? 'Update and regenerate' : uploading > 0 ? `Uploading (${uploading})` : 'Send'}
        >
          <HelmIcon name={sending || uploading > 0 ? 'loader' : 'arrow-up'} size={18} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
        </button>
      ) : text.trim() === '' ? (
        <Tooltip content="Stop the current execution" side="top">
          <button
            type="button"
            className="btn btn-sm btn-danger btn-pill btn-send composer-abort-button"
            onClick={() => void abortTurn()}
            title="Stop the current execution"
            aria-label="Stop the current execution"
          >
            <HelmIcon name="square" size={14} />
          </button>
        </Tooltip>
      ) : mobile ? (
        <div className="composer-busy-mobile-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary composer-mobile-steer-btn composer-steer-action"
            disabled={busyDisabled}
            onClick={() => void send('steer')}
            title="Inject at the next step boundary"
            aria-label={uploading > 0 ? `Uploading (${uploading})` : 'Steer'}
          >
            <HelmIcon
              name={sending || uploading > 0 ? 'loader' : 'corner-down-right'}
              size={13}
              className={sending || uploading > 0 ? 'spin-slow' : undefined}
            />
            <span>Steer</span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary composer-mobile-queue-btn"
            disabled={busyDisabled}
            onClick={() => void send('followUp')}
            title="Handle after the current turn ends"
            aria-label="Queue send"
          >
            <HelmIcon name="clock" size={13} />
            <span>Queue</span>
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
              title="Inject at the next step boundary (Enter)"
              aria-label={uploading > 0 ? `Uploading (${uploading})` : editingEntryId !== null ? 'Update and regenerate' : 'Steer'}
            >
              <HelmIcon
                name={sending || uploading > 0 ? 'loader' : 'corner-down-right'}
                size={14}
                className={sending || uploading > 0 ? 'spin-slow' : undefined}
              />
              <span className="composer-action-label">{editingEntryId !== null ? 'Update' : 'Insert'}</span>
            </button>
            <div className="composer-split-divider" />
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="composer-split-trigger"
                disabled={busyDisabled}
                aria-label="Choose a send strategy"
                title="Choose a send strategy (steer / queue)"
              >
                <HelmIcon name="chevron-down" size={12} />
              </button>
            </DropdownMenuTrigger>
          </div>
          <DropdownMenuContent portalled align="end" side="top" sideOffset={6} className="composer-busy-dropdown-content">
            <DropdownMenuItem
              className="composer-busy-menu-item"
              onClick={() => void send('steer')}
            >
              <HelmIcon name="corner-down-right" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">Steer</div>
                <div className="composer-busy-menu-desc">Inject at the next step boundary</div>
              </div>
              <span className="composer-busy-menu-kbd kbd-hint">Enter</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="composer-busy-menu-item composer-queue-button"
              onClick={() => void send('followUp')}
              title="Handle after the current turn ends (⌘/Ctrl+Enter)"
              aria-label="Queue send"
            >
              <HelmIcon name="clock" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">Queue send</div>
                <div className="composer-busy-menu-desc">Handle after the current turn ends</div>
              </div>
              <span className="composer-busy-menu-kbd kbd-hint">⌘/Ctrl+Enter</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              className="composer-busy-menu-item"
              onClick={() => void abortTurn()}
              title="Stop the current execution"
              aria-label="Stop the current execution"
            >
              <HelmIcon name="square" size={13} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">Stop execution</div>
                <div className="composer-busy-menu-desc">Abort the current turn immediately</div>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      )}
    </span>
  )
}
