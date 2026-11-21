/**
 * 物理作用域合并技能目录加载 Hook（React，非组件导出，符合 Fast Refresh）。
 *
 * - Hub 作用域（scope === undefined）不发请求：store 的 /api/skills 列表
 *   就是 Hub 目录真源；
 * - 物理作用域经 builtin:profile skill_catalog action 拉取合并目录，用代数
 *   竞争保护（generation 计数）防止切换作用域后旧请求反向覆盖新状态；
 * - reloadSeq 变化强制重拉（技能中心刷新按钮）；加载失败如实返回 error，
 *   绝不静默降级为空目录。
 */
import { useEffect, useRef, useState } from 'react'
import {
  fetchScopedSkillCatalog,
  type ScopedSkillCatalog,
  type SkillActionInvoker,
} from './skill-scope-api.js'
import { type SkillScope } from './skill-scope-model.js'

export interface ScopedSkillCatalogState {
  loading: boolean
  catalog: ScopedSkillCatalog | null
  error: string | null
}

const IDLE_STATE: ScopedSkillCatalogState = { loading: false, catalog: null, error: null }

export function useScopedSkillCatalog(
  scope: SkillScope | undefined,
  invoke: SkillActionInvoker,
  reloadSeq: number = 0,
): ScopedSkillCatalogState {
  const [state, setState] = useState<ScopedSkillCatalogState>(IDLE_STATE)
  const generationRef = useRef(0)
  const scopeNodeId = scope?.nodeId
  const scopeCwd = scope?.cwd

  useEffect(() => {
    if (scopeNodeId === undefined || scopeCwd === undefined) {
      generationRef.current += 1
      setState(IDLE_STATE)
      return
    }
    const scope: SkillScope = { nodeId: scopeNodeId, cwd: scopeCwd }
    const generation = ++generationRef.current
    setState((prev) =>
      prev.loading && prev.catalog === null && prev.error === null
        ? prev
        : { loading: true, catalog: null, error: null },
    )
    fetchScopedSkillCatalog(invoke, scope)
      .then((catalog) => {
        if (generationRef.current !== generation) return
        setState({ loading: false, catalog, error: null })
      })
      .catch((err: unknown) => {
        if (generationRef.current !== generation) return
        setState({
          loading: false,
          catalog: null,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, [scopeNodeId, scopeCwd, invoke, reloadSeq])

  return state
}
