import type { WhenBusy } from '@helm/protocol'
import { HelmIcon } from '@helm/plugin-client'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu.js'
import { Tooltip } from '../ui/Tooltip.js'
import type { SessionEnvBlocker } from './composer-model.js'

// ---------------------------------------------------------------------------
// 发送 / 停止控件（自 Composer.tsx 拆出）：空闲发送、正忙停止与插话/排队分流。
// props 命名与原组件内变量一致（send / abortTurn / uploading / text …），
// 保证源码级行为锚点（title / aria-label / 分支条件）逐字不变。
// ---------------------------------------------------------------------------

export interface ComposerSendControlsProps {
  working: boolean
  editingEntryId: number | null
  sending: boolean
  uploading: number
  envBlocker: SessionEnvBlocker
  text: string
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
  send,
  abortTurn,
}: ComposerSendControlsProps) {
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
              ? '更新并重新生成（将覆盖此条及后续对话并停止当前执行） (Enter)'
              : '更新并重新生成（将覆盖此条及后续对话） (Enter)'
            : envBlocker.blocked
              ? envBlocker.reason ?? '请先保存或取消起始环境修改'
              : '发送 (Enter)；Shift+Enter 换行'}
          aria-label={editingEntryId !== null ? '更新并重新生成' : uploading > 0 ? `上传中 (${uploading})` : '发送'}
        >
          <HelmIcon name={sending || uploading > 0 ? 'loader' : 'arrow-up'} size={18} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
        </button>
      ) : text.trim() === '' ? (
        <Tooltip content="停止当前执行" side="top">
          <button
            type="button"
            className="btn btn-sm btn-danger btn-pill btn-send composer-abort-button"
            onClick={() => void abortTurn()}
            title="停止当前执行"
            aria-label="停止当前执行"
          >
            <HelmIcon name="square" size={14} />
          </button>
        </Tooltip>
      ) : (
        <DropdownMenuRoot>
          <div className="composer-split-send">
            <button
              type="button"
              className="composer-split-main composer-steer-action"
              disabled={sending || uploading > 0 || envBlocker.blocked}
              onClick={() => void send('steer')}
              title="下一个步骤边界注入（Enter）"
              aria-label={uploading > 0 ? `上传中 (${uploading})` : editingEntryId !== null ? '更新并重新生成' : '插话引导'}
            >
              <HelmIcon
                name={sending || uploading > 0 ? 'loader' : 'corner-down-right'}
                size={14}
                className={sending || uploading > 0 ? 'spin-slow' : undefined}
              />
              <span className="composer-action-label">{editingEntryId !== null ? '更新' : '插话'}</span>
            </button>
            <div className="composer-split-divider" />
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="composer-split-trigger"
                disabled={sending || uploading > 0 || envBlocker.blocked}
                aria-label="选择发送策略"
                title="选择发送策略（插话 / 排队）"
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
                <div className="composer-busy-menu-title">插话引导</div>
                <div className="composer-busy-menu-desc">下一个步骤边界注入</div>
              </div>
              <span className="composer-busy-menu-kbd">Enter</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="composer-busy-menu-item composer-queue-button"
              onClick={() => void send('followUp')}
              title="当前回合结束后处理（⌘/Ctrl+Enter）"
              aria-label="排队发送"
            >
              <HelmIcon name="clock" size={14} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">排队发送</div>
                <div className="composer-busy-menu-desc">当前回合结束后处理</div>
              </div>
              <span className="composer-busy-menu-kbd">⌘/Ctrl+Enter</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              className="composer-busy-menu-item"
              onClick={() => void abortTurn()}
              title="停止当前执行"
              aria-label="停止当前执行"
            >
              <HelmIcon name="square" size={13} className="composer-busy-menu-icon" />
              <div className="composer-busy-menu-text">
                <div className="composer-busy-menu-title">停止执行</div>
                <div className="composer-busy-menu-desc">立即中止当前回合</div>
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      )}
    </span>
  )
}
