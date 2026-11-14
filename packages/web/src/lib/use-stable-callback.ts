/**
 * 稳定回调 hook：返回恒定身份的包装函数，调用时转发到最近一次 commit 的实现。
 *
 * 用于大组件中「离开组件」的边界（子组件 props、effect 依赖数组）：
 * - 只允许在事件处理器与 effect 中调用；渲染期调用见到的是上一次 commit 的
 *   实现，因此渲染期需要当前值的 memo factory 不得换成稳定包装；
 * - 实现经 useInsertionEffect 更新：同一 commit 内先于所有组件的 layout effect
 *   运行，子组件 layout effect 里调用即可见到本次 render 的实现；
 * - 最新实现只保存在实例级 ref，无模块级缓存：卸载后的旧包装函数仅指向该实例
 *   最后一次 commit 的实现，不影响后续实例；
 * - 组件内部互调继续用普通函数：await 之后仍作用于发起时的 render 快照，稳定
 *   包装只在入口取最新实现。
 */
import { useInsertionEffect, useRef, useState } from 'react'

export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn)
  useInsertionEffect(() => {
    latest.current = fn
  })
  // 包装函数身份由惰性初始化 state 锁定，组件整个生命周期恒定。
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  )
  return stable
}
