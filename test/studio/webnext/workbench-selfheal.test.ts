// @vitest-environment happy-dom
/**
 * workbench store 测试：全自动写章事件分派（方案《AI全生成·红项自愈闭环》§4.2）。
 *
 * 重点是 self_heal_reset 的回归护栏——整章重写产出的是**完整替换稿**，
 * textOut 是累加聚合，漏清缓冲会把多轮正文首尾拼接成畸形稿。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

describe('workbench store 自愈闭环事件', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('self_heal_reset 清空正文缓冲（防多轮重写拼接）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    wb.dispatch({ type: 'text', text: '第一版正文' })
    expect(wb.textOut).toBe('第一版正文')

    // 第 1 次重写开始
    wb.dispatch({ type: 'self_heal_reset' })
    expect(wb.textOut).toBe('')
    wb.dispatch({ type: 'text', text: '第二版正文' })

    // 第 2 次重写开始
    wb.dispatch({ type: 'self_heal_reset' })
    wb.dispatch({ type: 'text', text: '第三版正文' })

    // 只剩最后一版，不是三版拼接
    expect(wb.textOut).toBe('第三版正文')
  })

  it('role_spawn 开局置 running + 清上一轮终局态', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_result', outcome: 'escalate', reds: ['旧红项'] })
    wb.dispatch({ type: 'done', cost: 0, usage: 0, reason: 'success' })
    expect(wb.healResult?.outcome).toBe('escalate')
    expect(wb.running).toBe(false)

    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    expect(wb.running).toBe(true)
    expect(wb.healResult).toBeNull()
    expect(wb.healProgress).toBeNull()
    expect(wb.healPhase).toBeNull()
  })

  it('phase / progress 事件进对应 ref', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_phase', phase: 'checking' })
    expect(wb.healPhase).toBe('checking')

    wb.dispatch({ type: 'self_heal_progress', attempt: 2, maxAttempts: 3, remaining: ['红A', '红B'] })
    expect(wb.healProgress).toEqual({ attempt: 2, maxAttempts: 3, remaining: ['红A', '红B'] })

    wb.dispatch({ type: 'self_heal_phase', phase: 'rewriting' })
    expect(wb.healPhase).toBe('rewriting')
  })

  it('self_heal_result 存终局并清进度（pass 带 docId）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_progress', attempt: 1, maxAttempts: 3, remaining: ['红A'] })
    wb.dispatch({ type: 'self_heal_result', outcome: 'pass', docId: 'doc-1', path: '工作区/草稿-1.md' })

    expect(wb.healResult).toEqual({ outcome: 'pass', docId: 'doc-1', path: '工作区/草稿-1.md' })
    expect(wb.healProgress).toBeNull()
    expect(wb.healPhase).toBeNull()
  })

  it('escalate 终局带红项清单（唯一流到作者的路径）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_result', outcome: 'escalate', reds: ['命中禁词', '账本未闭合'] })
    expect(wb.healResult?.reds).toEqual(['命中禁词', '账本未闭合'])
  })

  it('done 收尾 running（终局由编排器补发）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    expect(wb.running).toBe(true)
    wb.dispatch({ type: 'self_heal_result', outcome: 'pass', docId: 'd' })
    expect(wb.running).toBe(true) // result 本身不收尾
    wb.dispatch({ type: 'done', cost: 0, usage: 0, reason: 'success' })
    expect(wb.running).toBe(false)
  })

  it('clear 清掉自愈态', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_phase', phase: 'drafting' })
    wb.dispatch({ type: 'self_heal_result', outcome: 'failed', error: 'x' })
    wb.clear()
    expect(wb.healPhase).toBeNull()
    expect(wb.healResult).toBeNull()
    expect(wb.textOut).toBe('')
  })
})
