/**
 * R0916-7-P3-16（2026-09-25 源码质量评审 P3-16 的 driver 半条）：长任务门控包装的
 * 「中断通道能力」回归。
 * （R0916-7 收尾批：文件由批号命名 r0916-p3-16-interrupt-capability.test.ts 改行为命名。）
 *
 * 沿革：批 2 曾以 resolveInterruptChannel 把可选成员显式解析（缺能力 → log.warn 留痕的
 * 显式降级）；收尾批（必需能力接口）把 registerCtrl/unregisterCtrl 随全族提为
 * `driver/types.ts` 的**必需成员**——「缺实现」在编译期不可表达（探针见
 * assembly-root-deps-injection.test.ts 用例③），warn 降级档随之删除。本文件钉两侧：
 * ① 有能力 = 注册/注销/释放三路必达（owner 分槽键逐位保留）；
 * ② mock 的「不支持中断」是**显式 no-op**——调用后不 abort、不推事件（防「补实现语义
 *    漂移成会中断」的回归锚：可选时代「缺席 → 消费点跳过 → 不中断」的运行时行为逐位保持）；
 * ③ 生产两实现（cc/mock）契约全成员在位（缺成员即类型错误，本锚为运行时双保险）。
 *
 * 驱动替身经 vi.mock 注入（getDriver 返回本文件装配的对象），不启服务、不碰真驱动。
 */
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../src/log/index.js'
import type { DriverEvent, Session, StudioDriver } from '../../src/driver/types.js'
import { mockDriver } from '../../src/driver/mock.js'
import { ccDriver } from '../../src/driver/cc.js'
import { isTaskGateHeld, runGatedGeneration } from '../../src/studio/server/api/task-gate.js'

/**
 * 替身驱动（中断通道按用例装配）；session 用最小对象——包装只把它递给能力面。
 * R0916-7-P3-6：必需能力面**恒给**（StudioDriver 全成员必需后替身天生齐全），本文件
 * 的替身不实现流式面（不消费）。
 */
const fakeDriver: Record<string, unknown> = {
  startSession: async (cwd: string): Promise<Session> => ({ id: '替身会话', cwd, closed: false }),
  stream: async function* (): AsyncGenerator<never> {},
  dispose: () => {},
  emit: () => {},
  cancelStream: () => {},
  interrupt: () => {},
  isRunning: () => false,
  isWriterRunning: () => false,
  registerCtrl: () => {},
  unregisterCtrl: () => {},
}
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

describe('R0916-7-P3-16：中断通道能力（必需契约下的注册/注销/释放三路必达）', () => {
  it('能力齐全 → ctrl 以 owner`${action}:${book}`注册，settle 后注销且闸释放（无降级告警）', async () => {
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
    expect(warnSpy).not.toHaveBeenCalled() // 必需契约下无「缺能力降级」告警面
    expect(registered).toHaveLength(1)
    expect(registered[0]!.session).toBe(fakeSession)
    expect(registered[0]!.owner).toBe('rag-build:替身书全能力') // 缺省 owner 标签（分槽键）
    expect(unregistered).toHaveLength(1)
    expect(unregistered[0]!.ctrl).toBe(gotCtrl)
    expect(isTaskGateHeld('替身书全能力', 'rag-build')).toBe(false)
  })

  it('fn 抛错 → 注销与释放仍必达（finally 三路：成功/失败/中断）', async () => {
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
    expect(unregistered).toHaveLength(1)
    expect(isTaskGateHeld('替身书抛错', 'outline')).toBe(false) // 闸不残留（否则该 action 永久 409）
  })
})

describe('R0916-7-P3-16 收尾：mock「不支持中断」为显式 no-op（运行时语义逐位不变）', () => {
  it('mock.interrupt 调用后：不 abort 在册 ctrl、不推 interrupted 事件（不因补实现变成会中断）', async () => {
    const session = await mockDriver.startSession('/tmp/替身目录')
    const ctrl = new AbortController()
    mockDriver.registerCtrl(session, ctrl, 'spawn')
    const received: DriverEvent[] = []
    const iter = mockDriver.stream(session)
    const consuming = (async () => {
      for await (const ev of iter) {
        received.push(ev)
        break // 收到首事件（init）即止
      }
    })()
    await vi.waitFor(() => expect(received.length).toBe(1)) // 流活着（init 已消费）
    mockDriver.interrupt(session)
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(ctrl.signal.aborted).toBe(false) // 显式 no-op：不 abort 任何 ctrl
    expect(received.length).toBe(1) // 不推 interrupted 事件（唯一事件仍是 init）
    expect(mockDriver.isRunning(session)).toBe(false) // 显式常量（可选时代消费点 ?? false 同值）
    expect(mockDriver.isWriterRunning(session)).toBe(false)
    await consuming // break 即隐式 iter.return，consumer 自 finally 摘除
    mockDriver.dispose(session)
  })

  it('生产两实现契约全成员在位（缺成员即类型错误；本锚为运行时双保险）', () => {
    const members = [
      'startSession',
      'stream',
      'cancelStream',
      'dispose',
      'interrupt',
      'isRunning',
      'isWriterRunning',
      'registerCtrl',
      'unregisterCtrl',
      'emit',
    ] as const
    for (const m of members) {
      expect(typeof (mockDriver as unknown as Record<string, unknown>)[m]).toBe('function')
      expect(typeof (ccDriver as unknown as Record<string, unknown>)[m]).toBe('function')
    }
  })
})
