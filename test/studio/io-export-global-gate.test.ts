/**
 * 内存审计修复（2026-08-24 批 A1）回归：全局导出 worker 并发闸。
 *
 * task-gate 只按书限并发（跨书可同时 spawn N 个 export worker，各持全书中转 + tsx
 * loader 基线，19GB 事故乘法项）——acquireExportSlot 全局 ≤2、超出排队、释放放行。
 */
import { describe, expect, it } from 'vitest'
import { acquireExportSlot } from '../../src/studio/server/api/io.js'

describe('A1 全局导出并发闸（acquireExportSlot）', () => {
  it('前两路立即放行，第三路排队；释放后按 FIFO 放行；全部释放后计数归零', async () => {
    const r1 = await acquireExportSlot()
    const r2 = await acquireExportSlot() // 到 cap：两路并发在跑
    let thirdAcquired = false
    const third = acquireExportSlot().then((r) => {
      thirdAcquired = true
      return r
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(thirdAcquired).toBe(false) // 第三路被排队

    r1() // 释放第一路 → 第三路被唤醒
    const r3 = await third
    expect(thirdAcquired).toBe(true)

    r2()
    r3()
    // 全部释放后可再取两路（计数归零，无残留占位）
    const a = await acquireExportSlot()
    const b = await acquireExportSlot()
    a()
    b()
  })

  // R65-45（总六十五轮）：release 改「名额转移」——原「release 先自减计数再 resolve
  // waiter、waiter 微任务恢复后才自增」之间存在窗口：窗口内新请求查 activeExportWorkers
  // < MAX 即插队直接放行，瞬时并发超 MAX=2（违反 A1 全局闸设计意图）。
  it('R65-45: release 转移名额的窗口内新请求不得插队（FIFO 保序，瞬时并发 ≤ MAX）', async () => {
    const settle = () => new Promise((r) => setTimeout(r, 20))
    const r1 = await acquireExportSlot()
    const r2 = await acquireExportSlot() // cap 满
    let w1Got = false
    const w1 = acquireExportSlot().then((rel) => {
      w1Got = true
      return rel
    })
    let w2Got = false
    const w2 = acquireExportSlot().then((rel) => {
      w2Got = true
      return rel
    })
    await settle()
    expect(w1Got).toBe(false)
    expect(w2Got).toBe(false) // 两路均在排队

    r1() // 名额转移给 w1（不自减计数）
    // 微任务窗口内的新请求：不得插队占用（修复前：r1 已自减 → 此请求见空位直接放行，
    // w1 恢复再自增 → 瞬时并发 3）
    let lateGot = false
    const late = acquireExportSlot().then((rel) => {
      lateGot = true
      return rel
    })
    await settle()
    expect(w1Got).toBe(true) // w1 拿到转移名额
    expect(lateGot).toBe(false) // R65-45 修复锚点：修复前此处为 true（插队放行）
    expect(w2Got).toBe(false) // w2 仍在 w1 之后排队

    const rel1 = await w1
    rel1() // 名额转移给 w2（FIFO：w2 先于 late 排队）
    await settle()
    expect(w2Got).toBe(true)
    expect(lateGot).toBe(false) // late 仍在队尾

    const rel2 = await w2
    rel2() // 名额转移给 late
    const relLate = await late
    expect(lateGot).toBe(true)
    relLate() // 无 waiter：真正归还
    r2() // 归还最后占位
  })
})
