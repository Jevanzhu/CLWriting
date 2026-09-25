/**
 * R0916-7-P3-3（2026-09-16 评审修复批）：runRegisteredBgTask 新家导出面直测。
 *
 * 被测行为：后台任务 ctrl 登记原语自 process/summary.ts 独立成 process/bg-task.ts 后
 * 语义逐位不变——① driver/session 接线时按 owner 登记 ctrl，run 拿到的 signal 即该
 * ctrl 的信号，settle（成功/失败）后注销；② 未接线（driver/session 缺）只建 ctrl
 * 不登记，中断面退化为无外部中断点（与修复前等价）；③ /interrupt 式 abort 经 run 的
 * signal 即时可见；④ 注销只针对自己（晚到的注销不抹同 session 新登记）。
 */
import { describe, expect, it } from 'vitest'
import { runRegisteredBgTask } from '../../src/process/bg-task.js'
import type { Session, StudioDriver } from '../../src/driver/index.js'

interface CtrlReg {
  session: unknown
  ctrl: AbortController
  owner: string
}

function fakeDriver(log: CtrlReg[]): StudioDriver {
  return {
    registerCtrl: (session: unknown, ctrl: AbortController, owner: string) => {
      log.push({ session, ctrl, owner })
    },
    unregisterCtrl: (session: unknown, ctrl: AbortController) => {
      const i = log.findIndex((r) => r.session === session && r.ctrl === ctrl)
      if (i >= 0) log.splice(i, 1)
    },
  } as unknown as StudioDriver
}

const SESSION = { id: 's1' } as unknown as Session

describe('process/bg-task：runRegisteredBgTask 导出面（R0916-7-P3-3）', () => {
  it('接线时按 owner 登记，run 收到该 ctrl 的信号，settle 后注销', async () => {
    const regs: CtrlReg[] = []
    const driver = fakeDriver(regs)
    let registeredCtrl: AbortController | null = null
    let runSignal: AbortSignal | null = null
    const out = await runRegisteredBgTask(driver, SESSION, 'bg-summary:测试书', async (signal) => {
      runSignal = signal
      expect(regs).toHaveLength(1)
      expect(regs[0]!.owner).toBe('bg-summary:测试书')
      expect(regs[0]!.session).toBe(SESSION)
      registeredCtrl = regs[0]!.ctrl
      return 'ok'
    })
    expect(out).toBe('ok')
    expect(runSignal!).toBe(registeredCtrl!.signal) // run 的信号即登记 ctrl 的信号
    expect(regs).toEqual([]) // settle 即注销
  })

  it('中断透传：外部 abort 登记 ctrl → run 内 signal 置位', async () => {
    const regs: CtrlReg[] = []
    const driver = fakeDriver(regs)
    const p = runRegisteredBgTask(driver, SESSION, 'bg-lead-draft:测试书', (signal) => {
      return new Promise<string>((res) => {
        signal.addEventListener('abort', () => res('aborted'))
      })
    })
    await Promise.resolve() // 让 run 进入等待
    regs[0]!.ctrl.abort()
    expect(await p).toBe('aborted')
    expect(regs).toEqual([])
  })

  it('未接线（driver/session 缺）：只建 ctrl 不登记，行为与修复前等价', async () => {
    const regs: CtrlReg[] = []
    const driver = fakeDriver(regs)
    const out = await runRegisteredBgTask(driver, null, 'bg-summary:测试书', async (signal) => {
      expect(signal.aborted).toBe(false)
      return 'no-driver'
    })
    expect(out).toBe('no-driver')
    expect(regs).toEqual([])
    const out2 = await runRegisteredBgTask(undefined, SESSION, 'bg-summary:测试书', async () => 'no-session')
    expect(out2).toBe('no-session')
    expect(regs).toEqual([])
  })

  it('result 失败 / 抛错也走 finally 注销（settle 即注销，不 leak 登记）', async () => {
    const regs: CtrlReg[] = []
    const driver = fakeDriver(regs)
    await expect(
      runRegisteredBgTask(driver, SESSION, 'bg-summary:测试书', async () => {
        expect(regs).toHaveLength(1)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(regs).toEqual([])
  })

  it('注销按 ctrl 身份比对：晚到的注销不抹掉同 session 后来的新登记', async () => {
    const regs: CtrlReg[] = []
    const driver = fakeDriver(regs)
    let ctrlOfFirst: AbortController | null = null
    await runRegisteredBgTask(driver, SESSION, 'bg-summary:书A', async () => {
      ctrlOfFirst = regs[0]!.ctrl
      return null
    })
    // 首个任务 settle 后同 session 登记新任务
    const p2 = runRegisteredBgTask(driver, SESSION, 'bg-summary:书A', async () => 'second')
    expect(regs).toHaveLength(1)
    expect(regs[0]!.ctrl).not.toBe(ctrlOfFirst)
    expect(await p2).toBe('second')
    expect(regs).toEqual([])
  })
})
