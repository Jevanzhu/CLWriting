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
})
