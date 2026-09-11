// @vitest-environment happy-dom
/**
 * R0911-C1-P3-1（2026-09-11 全量重评 GLM-5.3 修复批）回归：workbench.textOut 前端
 * 内存封顶——此前正文聚合无封顶（防线单侧依赖服务端锚契约：单次生成受 max_tokens
 * 约束、自愈重写有 reset 清缓冲），SSE 通道异常（事件风暴/重放）时 text 事件无界
 * 拼接撑爆渲染层内存。
 *
 * 封顶锚定值 1_000_000（UTF-16 码元）= 服务端输出流既定封顶常量 SSE_BACKPRESSURE_LIMIT
 * （src/studio/server/api/stream.ts；web-next 独立打包无法 import，字面对齐——服务端
 * 调值须同步 store 与本测试）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkbenchStore } from '../../../src/studio/web-next/src/stores/workbench'

const MAX_TEXT_OUT = 1_000_000

describe('workbench textOut 前端内存封顶（R0911-C1-P3-1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('单条超限 text 事件 → 截断保留最新段（丢最旧），不抛错不打断分派', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'role_spawn', role: 'writer' })
    const payload = '甲'.repeat(MAX_TEXT_OUT + 50_000) + '尾标'
    expect(() => wb.dispatch({ type: 'text', text: payload })).not.toThrow()
    // 保留方向：最新段——缓冲长度恰为封顶值，且内容 = payload 末尾 MAX_TEXT_OUT 码元
    expect(wb.textOut.length).toBe(MAX_TEXT_OUT)
    expect(wb.textOut).toBe(payload.slice(payload.length - MAX_TEXT_OUT))
    expect(wb.textOut.endsWith('尾标')).toBe(true)
    // 封顶只作用于正文聚合：running 等其余分派态不受影响
    expect(wb.running).toBe(true)
  })

  it('多条累计超限 → 封顶生效且保留方向为最新段（跨事件边界截断）', () => {
    const wb = useWorkbenchStore()
    const a = 'A'.repeat(600_000)
    const b = 'B'.repeat(500_002)
    wb.dispatch({ type: 'text', text: a })
    expect(wb.textOut).toBe(a) // 未过线不截断
    wb.dispatch({ type: 'text', text: b })
    const joined = a + b
    expect(wb.textOut.length).toBe(MAX_TEXT_OUT)
    // 最新段 = a 的尾部 + b 全量（丢弃最旧的 a 头部 2_002 码元）
    expect(wb.textOut).toBe(joined.slice(joined.length - MAX_TEXT_OUT))
    expect(wb.textOut.startsWith('A')).toBe(true)
    expect(wb.textOut.endsWith('B')).toBe(true)
  })

  it('恰好等于封顶线 → 不截断（> 判定，边界值原文全量保留）', () => {
    const wb = useWorkbenchStore()
    const exact = '章'.repeat(MAX_TEXT_OUT)
    wb.dispatch({ type: 'text', text: exact })
    expect(wb.textOut).toBe(exact)
  })

  it('常态路径（一章数千字）远低于封顶 → 原文逐字保留', () => {
    const wb = useWorkbenchStore()
    const chapter = '雪落在命题人的纸上。'.repeat(800) // ~8800 码元
    wb.dispatch({ type: 'text', text: chapter })
    expect(wb.textOut).toBe(chapter)
  })

  it('self_heal_reset 清空后重新聚合 → 封顶随新轮重算（旧轮超限态不滞留）', () => {
    const wb = useWorkbenchStore()
    wb.dispatch({ type: 'text', text: '旧'.repeat(MAX_TEXT_OUT + 10) })
    expect(wb.textOut.length).toBe(MAX_TEXT_OUT)
    wb.dispatch({ type: 'self_heal_reset' })
    expect(wb.textOut).toBe('')
    wb.dispatch({ type: 'text', text: '新版正文' })
    expect(wb.textOut).toBe('新版正文')
    expect(wb.textOut.length).toBeLessThan(MAX_TEXT_OUT)
  })
})
