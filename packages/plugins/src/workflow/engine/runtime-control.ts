/**
 * runtime-control.ts — 工作流并发信号量原语。
 *
 * release 直接将许可移交下一个排队等待者（避免连续释放波导致瞬时超并发）；
 * drain 在工作流终止时唤醒全部排队等待者以立即退出。
 */

export class Semaphore {
  private active = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.active--
  }

  drain(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.()
    }
  }
}
