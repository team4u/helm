import React, { useEffect, useState } from 'react'
import type { PluginDoctorReport } from '@helm/protocol'
import { pluginsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '../ui/Dialog.js'
import { Switch } from '../ui/Switch.js'
import {
  buildDoctorCheckItems,
  detectPluginSourceKind,
  extractDoctorReport,
  isInstallSourceSubmittable,
  pluginPackageErrorText,
} from './plugin-package-model.js'

export interface PluginInstallModalProps {
  open: boolean
  onClose: () => void
  /** 安装成功（服务端已注册插件）后回调；携带新插件 id 供导航进详情抽屉。 */
  onInstalled: (pluginId: string) => void
  /** 显式指定是否内联渲染（便于测试与 SSR 统一断言） */
  inline?: boolean
}

/**
 * 插件中心「安装插件」轻量模态：
 * - 接受 npm / git / 本地路径三类来源，输入旁即时识别来源类别；
 * - 如实告知安全边界：插件在 Hub 进程内运行、拥有宿主权限，不是沙箱；
 * - 安装中禁重复提交；失败时展示结构化 doctor 检查结果或错误诊断；
 * - 成功后刷新插件列表并导航至新插件详情抽屉（由父级完成）。
 */
export function PluginInstallModal({
  open,
  onClose,
  onInstalled,
  inline = false,
}: PluginInstallModalProps): React.JSX.Element {
  const [source, setSource] = useState('')
  const [enableAfterInstall, setEnableAfterInstall] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [doctorReport, setDoctorReport] = useState<PluginDoctorReport | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const trimmed = source.trim()
  const hint = detectPluginSourceKind(trimmed)
  const submittable = !installing && trimmed !== '' && isInstallSourceSubmittable(trimmed)

  // 打开时重置草稿与历史诊断；关闭期间不保留上次输入（草稿不进 URL/hash）。
  useEffect(() => {
    if (open) {
      setSource('')
      setEnableAfterInstall(false)
      setInstalling(false)
      setDoctorReport(null)
      setErrorText(null)
    }
  }, [open])

  const handleInstall = async () => {
    if (!submittable) return
    setInstalling(true)
    setErrorText(null)
    setDoctorReport(null)
    try {
      const result = await pluginsApi.install(trimmed, enableAfterInstall)
      // 安装成功：交由父级刷新列表并导航至新插件详情抽屉。
      onInstalled(result.summary.id)
      onClose()
    } catch (err) {
      // 安装失败时如实展示错误；doctor 报告（真实 Hub 在 details.report，经形状校验）逐项渲染。
      setErrorText(pluginPackageErrorText(err, '安装'))
      const report = extractDoctorReport(err)
      if (report) setDoctorReport(report)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen && !installing) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop" />
        <DialogContent
          className="modal plugin-install-modal"
          role="dialog"
          aria-label="安装插件"
        >
          <div className="modal-header">
            <DialogTitle className="modal-title">安装插件</DialogTitle>
            <DialogClose asChild>
              <button
                className="btn btn-ghost btn-sm"
                aria-label="关闭"
                title="关闭"
                disabled={installing}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="modal-body plugin-install-form">
            <DialogDescription className="visually-hidden">
              从 npm 包、Git 仓库或本地路径安装外部插件
            </DialogDescription>

            <div className="form-grid form-grid-align-start">
              <label htmlFor="plugin-install-source" className="form-grid-label">
                <span>安装来源</span>
              </label>
              <div className="plugin-install-input-wrap">
                <input
                  id="plugin-install-source"
                  className="input mono"
                  type="text"
                  placeholder="npm:pkg@1.0.0 / git:repo@ref / https://…git / /abs/path"
                  value={source}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={installing}
                  onChange={(e) => setSource(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && submittable) {
                      e.preventDefault()
                      void handleInstall()
                    }
                  }}
                />
                {trimmed !== '' && (
                  <span
                    className={`plugin-source-hint${hint.kind === 'unknown' ? ' is-unknown' : ''}`}
                    data-source-kind={hint.kind}
                  >
                    {hint.label}
                  </span>
                )}
              </div>
            </div>

            <div className="form-grid">
              <span className="form-grid-label">
                <span>安装后启用</span>
              </span>
              <Switch
                checked={enableAfterInstall}
                onChange={setEnableAfterInstall}
                disabled={installing}
                label={enableAfterInstall ? '安装完成后立即启用' : '安装后保持停用'}
              />
            </div>

            <div className="callout callout--warning plugin-install-security" role="note">
              <HelmIcon name="shield-alert" size={13} />
              <span>
                插件在 Hub 进程内运行，拥有宿主权限，不是沙箱。仅安装可信来源的插件包。
              </span>
            </div>

            {errorText && (
              <div className="callout callout--error" role="alert">
                <HelmIcon name="alert-circle" size={13} />
                <span className="selectable">{errorText}</span>
              </div>
            )}

            {doctorReport && (
              <div className="plugin-install-doctor" data-doctor-ok={doctorReport.ok}>
                {(doctorReport.checks ?? []).map((check) => {
                  const item = buildDoctorCheckItems(doctorReport).find((c) => c.id === check.id)
                  return (
                    <div
                      key={check.id}
                      className={`plugin-doctor-check${check.error === undefined ? '' : ' is-failed'}`}
                    >
                      <span className="plugin-doctor-check-mark">
                        {check.error === undefined ? (
                          <HelmIcon name="check" size={11} />
                        ) : (
                          <HelmIcon name="x" size={11} />
                        )}
                      </span>
                      <span className="plugin-doctor-check-body">
                        <span className="plugin-doctor-check-label">{check.label}</span>
                        {item && !item.ok && (
                          <span className="plugin-doctor-check-error mono selectable">
                            {item.errorText}
                          </span>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="modal-footer">
            <DialogClose asChild>
              <button className="btn btn-ghost btn-sm" disabled={installing}>
                取消
              </button>
            </DialogClose>
            <button
              className="btn btn-primary btn-sm"
              disabled={!submittable}
              onClick={() => void handleInstall()}
            >
              {installing ? (
                <>
                  <HelmIcon name="loader" size={12} />
                  <span>正在安装…</span>
                </>
              ) : (
                <>
                  <HelmIcon name="download" size={12} />
                  <span>安装</span>
                </>
              )}
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
