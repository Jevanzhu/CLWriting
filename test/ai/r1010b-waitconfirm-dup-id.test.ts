/**
 * R1010b-AI-P3-2（2026-09-10 内存专项重审修复批）回归：waitConfirm 重复 tool_use id
 * 登记前查重收口旧项。
 *
 * 修复前：模型退化输出两个同 id tool_use 块时第二次 state.pending.set 直接顶掉旧项
 * resolve——旧确认的作者通道失联（只能干等其超时兜底），且旧项 timer 到点回调里的
 * pending.delete(callId) 会误删新项登记。修复后：set 前查重，旧项按本表既有 resolve
 * 用法（取消终态）收口（finish 幂等清理 timer/listener）+ log.warn 留痕，再登记新项。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { waitConfirm } from '../../src/ai/orchestrate/chat/turns.js'
import type { ChatRunState } from '../../src/ai/orchestrate/chat/state.js'
import { log } from '../../src/log/index.js'

function mkState(): ChatRunState {
  return { ctrl: new AbortController(), deadline: Date.now() + 60_000, pending: new Map() }
}

describe('R1010b-AI-P3-2：确认闸重复 tool_use id 查重', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('重复 id 登记收口旧项（取消终态、非超时兜底）+ warn 留痕 + 新项作者通道健康', async () => {
    const warnSpy = vi.spyOn(log, 'warn')
    const state = mkState()
    const first = waitConfirm(state, 'dup-id', 60_000)
    const second = waitConfirm(state, 'dup-id', 60_000)

    // 旧项立即按取消终态收口（修复前：first 挂到超时才 resolve，其作者通道已被 second 顶掉）
    await expect(first).resolves.toBe(false)
    // 新项在册，旧项收口未误删新登记
    expect(state.pending.has('dup-id')).toBe(true)
    // 留痕带取代缘（结构化原因）
    expect(warnSpy).toHaveBeenCalledWith('chat', expect.stringContaining('重复 tool_use id'))

    // 新项作者确认 → true + 表项清理（finish 幂等收口后不残留）
    state.pending.get('dup-id')!(true)
    await expect(second).resolves.toBe(true)
    expect(state.pending.has('dup-id')).toBe(false)
  })

  it('收口旧项后新项 abort 语义不受损（旧 listener 已随旧 finish 幂等移除，abort 只放行新项）', async () => {
    vi.spyOn(log, 'warn')
    const state = mkState()
    const first = waitConfirm(state, 'dup-abort', 60_000)
    const second = waitConfirm(state, 'dup-abort', 60_000)
    await expect(first).resolves.toBe(false)

    state.ctrl.abort()
    await expect(second).resolves.toBe(false)
    expect(state.pending.has('dup-abort')).toBe(false)
  })
})
