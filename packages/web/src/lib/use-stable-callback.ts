/**
 * Stable callback hook: returns a wrapper function with constant identity that
 * forwards to the implementation committed most recently.
 *
 * Used at the "leaves the component" boundaries of large components (child
 * props, effect dependency arrays):
 * - Call it only from event handlers and effects; a render-phase call sees the
 *   previous commit's implementation, so memo factories that need the current
 *   value at render time must not switch to the stable wrapper;
 * - The implementation updates via useInsertionEffect: within one commit it
 *   runs before every component's layout effect, so child layout effects
 *   already see this render's implementation;
 * - The latest implementation lives in an instance-level ref only, no
 *   module-level cache: after unmount the old wrapper still points at that
 *   instance's last committed implementation and cannot affect later ones;
 * - Keep plain functions for intra-component calls: after an await they still
 *   act on the render snapshot that started the call; the stable wrapper only
 *   picks the latest implementation at the entry point.
 */
import { useInsertionEffect, useRef, useState } from 'react'

export function useStableCallback<Args extends ReadonlyArray<unknown>, Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(fn)
  useInsertionEffect(() => {
    latest.current = fn
  })
  // The wrapper identity is locked by lazily initialized state and stays constant for the component's lifetime.
  const [stable] = useState(
    () =>
      (...args: Args) =>
        latest.current(...args),
  )
  return stable
}
