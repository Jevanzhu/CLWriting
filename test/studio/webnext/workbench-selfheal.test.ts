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

  // M-12 回归：切书 clear() 一并复位 running——旧实现残留 true 让新书工作台
  // 无限显示「生成中」（新书 SSE connect 快照校正前的时间窗内按钮全被禁用）
  it('M-12：running 中 clear() → running 复位 false', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    expect(wb.running).toBe(true)
    wb.clear()
    expect(wb.running).toBe(false)
  })
})

// Q-4（第十五轮）：断线重连的 sync 只回 running 布尔——批次在断连窗口内收尾
// （self_heal_result 丢失）时，自愈状态机若残留「进行中」会永久卡「正在写稿…」
//（M-12 只处理了 running 复位）。running=false 且自愈态残留 → 连带复位 + 中断提示。
describe('Q-4：sync 快照复位残留自愈态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('断线期间批次结束 → 重连 sync(running=false) 复位 healPhase/batchProgress 并提示', () => {
    const wb = useWorkbenchStore()
    // 自愈进行中（phase 残留 + 批量进度）
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    wb.dispatch({ type: 'self_heal_phase', phase: 'drafting' })
    wb.dispatch({ type: 'self_heal_batch', total: 3 })
    wb.dispatch({ type: 'self_heal_phase', phase: 'chapter_start', chapter: 1, done: 0, total: 3 })
    expect(wb.healPhase).toBe('chapter_start')

    // 断连重连：服务端批次已收尾 → sync 只说 running=false
    wb.dispatch({ type: 'sync', running: false })
    expect(wb.running).toBe(false)
    expect(wb.healPhase).toBeNull() // 修复前残留 'drafting' → 界面永久卡「正在写稿…」
    expect(wb.healProgress).toBeNull()
    expect(wb.batchProgress).toBeNull()
    expect(wb.warning).toContain('连接中断')
  })

  it('对照：批次仍在跑的重连 sync(running=true) 不动自愈态', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    wb.dispatch({ type: 'self_heal_phase', phase: 'checking' })
    wb.dispatch({ type: 'sync', running: true })
    expect(wb.healPhase).toBe('checking')
    expect(wb.warning).toBeNull()
  })

  it('对照：空闲连接 sync(running=false) 无自愈残留 → 无提示', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'sync', running: false })
    expect(wb.warning).toBeNull()
  })
})
