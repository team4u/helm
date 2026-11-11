/**
 * builtin:apps client 占位模块。
 *
 * 【合并注意事项】AppCenterScreen 的完整实现由 Web 分支（应用中心主舞台）
 * 提供；本文件仅保证 `screen:builtin:apps/center` 的 client 引用可编译加载，
 * 不承载任何业务逻辑。Web 分支合并时整体替换本文件与 styles.css。
 */
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import './styles.css'

export function AppCenterScreen(_props: ScreenProps): ReactNode {
  return (
    <div className="apps-center-placeholder">
      <p>应用中心视图由 Web 分支提供；当前构建仅包含后端动作与目录。</p>
      <p>可用 CLI：helm apps list / validate / publish / update_meta / remove</p>
    </div>
  )
}
