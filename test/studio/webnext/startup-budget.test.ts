/**
 * 启动预算守卫：boot 与偏好加载按「合计总预算」等待——常规路径毫秒级不受影响；
 * API 异常（接受连接但不响应）时到期即放行挂载，不阻塞首帧（原先两段串联无上界，
 * 白屏可达 ~50s）。
 *
 * 末条为接线防漂移断言（治理性质，读 main.ts 文本）：启动等待必须经本守卫。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STARTUP_BUDGET_MS, awaitStartupWithBudget } from '../../../src/studio/web-next/src/shared/startup-budget'

const never = (): Promise<never> => new Promise<never>(() => {})

describe('启动预算守卫（boot + 偏好加载合计预算）', () => {
  it('常规路径：各步骤快速落定 → 全部完成且远未触预算（行为与直等一致）', async () => {
    const ran: string[] = []
    await awaitStartupWithBudget(
      [
        async () => {
          ran.push('boot')
        },
        async () => {
          ran.push('prefs')
        },
      ],
      STARTUP_BUDGET_MS,
    )
    expect(ran).toEqual(['boot', 'prefs'])
  })

  it('首段挂死：预算到期即放行——后续段仍被调用，总耗时远小于 21s/30s 量级', async () => {
    const t0 = Date.now()
    let secondCalled = false
    await awaitStartupWithBudget(
      [
        never,
        async () => {
          secondCalled = true
        },
      ],
      40,
    )
    const cost = Date.now() - t0
    expect(secondCalled).toBe(true)
    expect(cost).toBeGreaterThanOrEqual(30)
    expect(cost).toBeLessThan(1_000)
  })

  it('前段耗用部分预算：后段只等剩余额度（合计封顶，非每段独立预算）', async () => {
    const t0 = Date.now()
    let lateTimer: ReturnType<typeof setTimeout> | undefined
    await awaitStartupWithBudget(
      [
        () => new Promise<void>((r) => setTimeout(r, 100)),
        () =>
          new Promise<void>((r) => {
            lateTimer = setTimeout(r, 800)
          }),
      ],
      300,
    )
    const cost = Date.now() - t0
    if (lateTimer) clearTimeout(lateTimer)
    expect(cost).toBeGreaterThanOrEqual(250)
    expect(cost).toBeLessThan(600) // 合计 ≈300；每段独立预算会是 100+300=400+，后段不封顶则 ≈900
  })

  it('步同步抛错不阻断启动（按已落定继续）；p 拒绝不炸（双面 settle）', async () => {
    const ran: string[] = []
    await awaitStartupWithBudget([
      () => {
        throw new Error('同步抛错')
      },
      () => Promise.reject(new Error('拒绝')),
      async () => {
        ran.push('后续段')
      },
    ])
    expect(ran).toEqual(['后续段'])
  })

  it('接线防漂移：main.ts 的启动两段必须经 awaitStartupWithBudget（读文本断言）', () => {
    const mainSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../src/studio/web-next/src/main.ts'),
      'utf8',
    )
    expect(mainSrc).toMatch(/awaitStartupWithBudget\(\[boot, \(\) => usePrefsStore\(\)\.init\(\)\]\)/)
  })
})
