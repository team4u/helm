import React, { useEffect, useMemo, useState } from 'react'
import { DEFAULT_HELMX_LOCALE, type PluginDoctorReport } from '@helmx/protocol/browser'
import { pluginsApi } from '../lib/api.js'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalLocale } from '../lib/store-context.js'
import { HelmxIcon, Dialog, DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle, Switch } from '@helmx/plugin-client'
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
  /** 安装成功（服务端已注册插件）后回调；携带新插件 id 供导航进详情抽屉与启用诊断。 */
  onInstalled: (pluginId: string, enableError?: { code: string; message: string }) => void
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
  const storeLocale = useOptionalLocale()
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const [source, setSource] = useState('')
  const [enableAfterInstall, setEnableAfterInstall] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [doctorReport, setDoctorReport] = useState<PluginDoctorReport | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const trimmed = source.trim()
  const hint = detectPluginSourceKind(trimmed, t)
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
      // 安装成功：交由父级刷新列表并导航至新插件详情抽屉；启用失败仍如实向父级传递。
      onInstalled(result.summary.id, result.enableError)
      onClose()
    } catch (err) {
      // 安装失败时如实展示错误；doctor 报告（真实 Hub 在 details.report，经形状校验）逐项渲染。
      setErrorText(pluginPackageErrorText(err, t('plugins.package.action.install'), t))
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
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal plugin-install-modal"
            role="dialog"
            aria-label={t('plugins.installPlugin')}
          >
          <div className="modal-header">
            <DialogTitle className="modal-title">{t('plugins.installPlugin')}</DialogTitle>
            <DialogClose asChild>
              <button
                className="btn btn-ghost btn-sm"
                aria-label={t('common.close')}
                title={t('common.close')}
                disabled={installing}
              >
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="modal-body plugin-install-form">
            <DialogDescription className="visually-hidden">
              {t('plugins.install.description')}
            </DialogDescription>

            <div className="form-grid form-grid-align-start">
              <label htmlFor="plugin-install-source" className="form-grid-label">
                <span>{t('plugins.install.sourceLabel')}</span>
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
                <span>{t('plugins.install.enableAfterInstall')}</span>
              </span>
              <Switch
                checked={enableAfterInstall}
                onChange={setEnableAfterInstall}
                disabled={installing}
                label={enableAfterInstall ? t('plugins.install.enableNow') : t('plugins.install.keepDisabled')}
              />
            </div>

            <div className="callout callout-warn plugin-install-security" role="note">
              <HelmxIcon name="shield-alert" size={13} />
              <span className="callout-text">
                {t('plugins.install.securityWarning')}
              </span>
            </div>

            {errorText && (
              <div className="callout callout-error" role="alert">
                <HelmxIcon name="alert-circle" size={13} />
                <span className="callout-text selectable">{errorText}</span>
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
                          <HelmxIcon name="check" size={11} />
                        ) : (
                          <HelmxIcon name="x" size={11} />
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
                {t('common.cancel')}
              </button>
            </DialogClose>
            <button
              className="btn btn-primary btn-sm"
              disabled={!submittable}
              onClick={() => void handleInstall()}
            >
              {installing ? (
                <>
                  <HelmxIcon name="loader" size={12} />
                  <span>{t('plugins.install.installing')}</span>
                </>
              ) : (
                <>
                  <HelmxIcon name="download" size={12} />
                  <span>{t('plugins.install.submit')}</span>
                </>
              )}
            </button>
          </div>
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </Dialog>
  )
}
