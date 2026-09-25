/**
 * R0916-7-P3-16（2026-09-25 源码质量评审 P3-16 的 driver 半条）：长任务门控包装的
 * 「中断通道能力」回归。
 *
 * P3-16 前：runGatedGeneration 用 `driver.registerCtrl?.(...)` / `?.unregisterCtrl` 直调
 * 可选成员——替身驱动没实现时**静默 fail-open**（任务照跑但不可中断，无任何留痕，
 * 事后查不出「为什么这次生成中断不了」）。修复后：能力面经 resolveInterruptChannel
 * 显式解析，缺任一法 → log.warn 带 `action@book` 留痕（可回溯到具体端点），降级面
 * 如实声明为「可跑不可中断」——不 fail-closed（那会让测试替身上的端点整体不可用，
 * 真驱动 cc 实现齐全）。本文件钉两侧：缺能力 = 跑+警告；有能力 = 注册/注销/释放三路必达。
 *
 * 驱动替身经 vi.mock 注入（getDriver 返回本文件装配的对象），不启服务、不碰真驱动。
 */
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../src/log/index.js'
import type { Session, StudioDriver } from '../../src/driver/types.js'
import { isTaskGateHeld, runGatedGeneration } from '../../src/studio/server/api/task-gate.js'

/** 替身驱动（能力面按用例装配）；session 用最小对象——包装只把它递给能力面。 */
const fakeDriver: Record<string, unknown> = {}
const fakeSession = { bookId: '替身会话', closed: false } as unknown as Session

vi.mock('../../src/driver/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/driver/index.js')>()
  return {
    ...orig,
    getDriver: () => fakeDriver as unknown as StudioDriver,
    ensureSession: async () => fakeSession,
  }
})

/** 包装只写 res 于失败路径；成功路径不触 res——空壳够用（不真发响应）。 */
const resStub = {} as unknown as ServerResponse

afterEach(() => {
  delete fakeDriver['registerCtrl']
  delete fakeDriver['unregisterCtrl']
  vi.restoreAllMocks()
})

describe('R0916-7-P3-16：中断通道能力显式化（不再静默 fail-open）', () => {
  it('驱动缺 registerCtrl/unregisterCtrl → 任务照跑完 + log.warn 留痕（可跑不可中断的显式降级）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    let ran = false
    await runGatedGeneration(
      resStub,
      { book: '替身书缺能力', workDir: '替身目录', action: 'analyze', busyText: '忙' },
      async () => {
        ran = true
      },
    )
    expect(ran).toBe(true) // 降级不是 fail-closed：端点整体可用性优先
    expect(isTaskGateHeld('替身书缺能力', 'analyze')).toBe(false) // 闸照常释放
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]![0]).toBe('task-gate')
    // 留痕须可回溯到具体端点（action@book）与降级后果（不可被 /interrupt 中断）
    expect(warnSpy.mock.calls[0]![1]).toContain('analyze@替身书缺能力')
    expect(warnSpy.mock.calls[0]![1]).toContain('不可被 /interrupt 中断')
  })

  it('能力齐全 → 零告警；ctrl 以 owner`${action}:${book}`注册，settle 后注销且闸释放', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const registered: Array<{ session: Session; ctrl: AbortController; owner?: string }> = []
    const unregistered: Array<{ session: Session; ctrl: AbortController }> = []
    fakeDriver['registerCtrl'] = (session: Session, ctrl: AbortController, owner?: string) =>
      registered.push({ session, ctrl, owner })
    fakeDriver['unregisterCtrl'] = (session: Session, ctrl: AbortController) => unregistered.push({ session, ctrl })

    let gotCtrl: AbortController | null = null
    await runGatedGeneration(
      resStub,
      { book: '替身书全能力', workDir: '替身目录', action: 'rag-build', busyText: '忙' },
      async (ctrl) => {
        gotCtrl = ctrl
        expect(isTaskGateHeld('替身书全能力', 'rag-build')).toBe(true) // 持有段内闸在持
      },
    )
    expect(warnSpy).not.toHaveBeenCalled() // 能力齐全无降级告警
    expect(registered).toHaveLength(1)
    expect(registered[0]!.session).toBe(fakeSession)
    expect(registered[0]!.owner).toBe('rag-build:替身书全能力') // 缺省 owner 标签（分槽键）
    expect(unregistered).toHaveLength(1)
    expect(unregistered[0]!.ctrl).toBe(gotCtrl)
    expect(isTaskGateHeld('替身书全能力', 'rag-build')).toBe(false)
  })

  it('fn 抛错 → 注销与释放仍必达（finally 三路：成功/失败/中断）', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const unregistered: AbortController[] = []
    fakeDriver['registerCtrl'] = () => {}
    fakeDriver['unregisterCtrl'] = (_s: Session, ctrl: AbortController) => unregistered.push(ctrl)

    await expect(
      runGatedGeneration(
        resStub,
        { book: '替身书抛错', workDir: '替身目录', action: 'outline', busyText: '忙' },
        async () => {
          throw new Error('端点主体炸了')
        },
      ),
    ).rejects.toThrow('端点主体炸了')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(unregistered).toHaveLength(1)
    expect(isTaskGateHeld('替身书抛错', 'outline')).toBe(false) // 闸不残留（否则该 action 永久 409）
  })
})
