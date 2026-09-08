// @vitest-environment happy-dom
/**
 * 批2-A（2026-09-07 全量代码重审 批2-A）回归：dispatch 的 sync(running=false) 残留
 * 复位漏掉 healResult——断线窗后终局卡片残留。
 *
 * 场景：批量连写中第 N 章的 self_heal_result 已到（终局卡片显示），断连窗口内批次
 * 继续/收尾（后续事件无补发）；重连 sync(running=false) 已复位 healPhase/healProgress/
 * batchProgress 并提示「写章结果未知」，但 healResult 原样残留——界面一边挂着过期
 * 终局卡、一边提示结果未知，自相矛盾。修复：sync 残留复位处连带清 healResult
 * （对齐 healPhase/progress/batchProgress 的清理口径）。
 *
 * done 分支的对照锚：终局卡片须跨 done 存续（服务端 emitResult 先 self_heal_result
 * 后 done——src/ai/orchestrate/self-heal.ts emitResult；清了卡片永不显示），
 * workbench-selfheal.test「role_spawn 开局置 running + 清上一轮终局态」已锁该行为，
 * 本文件再钉一道边界，说明批2-A 的修复面为何只落在 sync 分支。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

describe('批2-A · sync(running=false) 连带复位 healResult', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('断线期间批次收尾 → 重连 sync(running=false) 复位终局卡片（修复前残留）', () => {
    const wb = useWorkbenchStore()
    // 批量连写：第 1 章终局已到（卡片显示），批次继续（chapter_start 残留 + 批量进度）
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    wb.dispatch({ type: 'self_heal_batch', total: 3 })
    wb.dispatch({ type: 'self_heal_result', outcome: 'pass', docId: 'd1', path: '工作区/草稿-1.md' })
    wb.dispatch({ type: 'self_heal_phase', phase: 'chapter_start', chapter: 2, done: 1, total: 3 })
    expect(wb.healResult).not.toBeNull()

    // 断连重连：服务端批次已在窗口内收尾 → sync 只说 running=false
    wb.dispatch({ type: 'sync', running: false })
    expect(wb.running).toBe(false)
    expect(wb.healPhase).toBeNull()
    expect(wb.healProgress).toBeNull()
    expect(wb.batchProgress).toBeNull()
    expect(wb.healResult).toBeNull() // 修复前：终局卡片残留（与「结果未知」提示自相矛盾）
    expect(wb.warning).toContain('连接中断')
  })

  it('对照：完成态空闲重连 sync(running=false)（无进行中残留）不清终局卡片', () => {
    const wb = useWorkbenchStore()
    // 正常收工态：result → done（终局卡片是收工展示面，healPhase/batchProgress 已清）
    wb.dispatch({ type: 'role_spawn', role: 'writer', parentToolUseId: 'self-heal' })
    wb.dispatch({ type: 'self_heal_result', outcome: 'pass', docId: 'd1' })
    wb.dispatch({ type: 'done', usage: 100, reason: 'success' })
    // 空闲期网络抖动重连：sync(running=false) 无自愈残留 → 不触发清理，卡片存续
    wb.dispatch({ type: 'sync', running: false })
    expect(wb.healResult?.outcome).toBe('pass')
    expect(wb.warning).toBeNull()
  })

  it('对照：done 不清 healResult（终局卡片跨 done 存续——批2-A 调查锚，同 workbench-selfheal 已锁行为）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'self_heal_result', outcome: 'escalate', reds: ['红A'] })
    wb.dispatch({ type: 'done', usage: 0, reason: 'success' })
    // 服务端 emitResult 先 result 后 done：done 若清卡片则终局永不显示——不清是设计行为
    expect(wb.healResult?.outcome).toBe('escalate')
    expect(wb.running).toBe(false)
  })
})
