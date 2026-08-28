/**
 * M-1（第八轮）回归：cc driver 的 registerCtrl owner 分槽——跨编排 ctrl 并存不互相
 * 抢占（chat 纯问答 × self-heal/spawn 写稿是既定并发场景）。
 *
 * 修复背景：原先单槽 Map + P2-6「换新先 abort 旧」——self-heal 在途（十几分钟批量
 * 写章）时 chat 首轮 runTask register 即把 self-heal 的 ctrl 静默 abort（一句自然
 * 提问杀死批量写章，self_heal_result aborted）。owner 分槽后：同 owner 换新保持
 * P2-6（同编排多轮循环换新防僵尸），跨 owner 互不 abort，interrupt/dispose 全量终止。
 * 本测试锁五件事：
 * 1. 跨 owner register 不 abort 旧 owner 的 ctrl；
 * 2. 同 owner 换新 ctrl 先 abort 旧的（P2-6 保留）；
 * 3. 同一 ctrl 重复登记幂等（不自 abort）；
 * 4. unregister 只注销自己（跨 owner 的另一路不受影响）；
 * 5. interrupt 终止全部 owner 的在途 ctrl（用户中断语义是全停）。
 */
import { describe, expect, it } from 'vitest'
import { ccDriver } from '../../src/driver/cc.js'
import type { Session, DriverEvent } from '../../src/driver/types.js'

function makeSession(): Session {
  return { id: `s-${Math.random().toString(36).slice(2)}`, cwd: '/tmp', closed: false }
}

function collect(drv: { stream(s: Session): AsyncIterable<DriverEvent> }, s: Session): DriverEvent[] {
  const out: DriverEvent[] = []
  void (async () => {
    for await (const ev of drv.stream(s)) out.push(ev)
  })()
  return out
}

describe('M-1: registerCtrl owner 分槽（跨编排不抢占）', () => {
  const driver = ccDriver

  it('跨 owner register 不 abort 旧 owner 的 ctrl', () => {
    const s = makeSession()
    const heal = new AbortController()
    const chat = new AbortController()
    driver.registerCtrl?.(s, heal, 'self-heal')
    driver.registerCtrl?.(s, chat, 'chat')
    expect(heal.signal.aborted).toBe(false) // 原先单槽语义下这里会被 abort
    expect(chat.signal.aborted).toBe(false)
    expect(driver.isRunning?.(s)).toBe(true)
    driver.dispose(s)
  })

  it('同 owner 换新 ctrl 先 abort 旧的（P2-6 保留）', () => {
    const s = makeSession()
    const old = new AbortController()
    const fresh = new AbortController()
    driver.registerCtrl?.(s, old, 'self-heal')
    driver.registerCtrl?.(s, fresh, 'self-heal')
    expect(old.signal.aborted).toBe(true)
    expect(fresh.signal.aborted).toBe(false)
    driver.dispose(s)
  })

  it('同一 ctrl 重复登记幂等（不自 abort）', () => {
    const s = makeSession()
    const c = new AbortController()
    driver.registerCtrl?.(s, c, 'chat')
    driver.registerCtrl?.(s, c, 'chat')
    expect(c.signal.aborted).toBe(false)
    driver.dispose(s)
  })

  it('unregister 只注销自己：self-heal 终态不抹掉在途 chat', () => {
    const s = makeSession()
    const heal = new AbortController()
    const chat = new AbortController()
    driver.registerCtrl?.(s, heal, 'self-heal')
    driver.registerCtrl?.(s, chat, 'chat')
    driver.unregisterCtrl?.(s, heal)
    expect(heal.signal.aborted).toBe(false)
    expect(driver.isRunning?.(s)).toBe(true) // chat 仍在途
    driver.unregisterCtrl?.(s, chat)
    expect(driver.isRunning?.(s)).toBe(false)
    driver.dispose(s)
  })

  it('interrupt 终止全部 owner 的在途 ctrl 并清登记', async () => {
    const s = makeSession()
    const events = collect(driver, s)
    const heal = new AbortController()
    const chat = new AbortController()
    driver.registerCtrl?.(s, heal, 'self-heal')
    driver.registerCtrl?.(s, chat, 'chat')
    driver.interrupt?.(s)
    expect(heal.signal.aborted).toBe(true)
    expect(chat.signal.aborted).toBe(true)
    expect(driver.isRunning?.(s)).toBe(false)
    await new Promise((r) => setTimeout(r, 20)) // 广播到消费者是异步的
    expect(events.some((e) => e.type === 'interrupted')).toBe(true)
    driver.dispose(s)
  })

  it('R71-19（十九轮）：chat owner 带书维度——同 session 跨书并存不互相抢占', () => {
    // 两本书共享 session：`chat:<book>` 分槽后，后书对话不 abort 前书在途 ctrl；
    // 同书换新仍保持 P2-6「先 abort 旧」。
    const s = makeSession()
    const a = new AbortController()
    const b = new AbortController()
    driver.registerCtrl?.(s, a, 'chat:书甲')
    driver.registerCtrl?.(s, b, 'chat:书乙')
    expect(a.signal.aborted).toBe(false) // 修复前同 'chat' 槽会被 B 抢占 abort
    expect(b.signal.aborted).toBe(false)
    expect(driver.isRunning?.(s)).toBe(true)
    // 同书（书甲）换新：旧 ctrl 被 abort（P2-6 保留）
    const aNew = new AbortController()
    driver.registerCtrl?.(s, aNew, 'chat:书甲')
    expect(a.signal.aborted).toBe(true)
    expect(aNew.signal.aborted).toBe(false)
    expect(b.signal.aborted).toBe(false) // 书乙不受书甲换新影响
    driver.dispose(s)
  })
})
