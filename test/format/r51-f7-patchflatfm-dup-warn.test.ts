/**
 * R51-F-7b（五十一轮）回归：patchFlatFm 重复同名顶层键静默丢弃补 warn 留痕。
 *
 * 手写脏数据（同名键两处）时丢弃行为保留（首个按 updates 改写、后续连子行丢弃，
 * 防解析歧义），但此前零留痕——作者第二处键值被吞后「改配置不生效」无诊断线索
 * （R76-15「写了但不生效无迹可查」纪律）。
 */
import { test, expect, vi } from 'vitest'
import { patchFlatFm } from '../../src/format/frontmatter.js'
import { log } from '../../src/log/index.js'

test('R51-F-7b: 重复顶层键 → 保留首个（改写生效）+ warn 留痕，后续连子行丢弃不变', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const fmRaw = ['标题: 旧书名', '标签: [a]', '标题: 另一个书名', '标签: [b]'].join('\n')
    // updates 须命中重复键才触发丢弃分支（未命中的重复键行走原样透传，语义不变）
    const r = patchFlatFm(fmRaw, { 标题: '新书名', 标签: ['x'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 行为不变：首个键行改写；重复键及其子行丢弃
    expect(r.text).toContain('标题: 新书名')
    expect(r.text).not.toContain('另一个书名')
    expect(r.text).toContain('标签: [x]')
    expect(r.text).not.toContain('[b]')
    expect(r.text).not.toContain('标签: [a]')
    // 修复点：warn 留痕点名键名（标题、标签各一处重复）
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('重复同名顶层键「标题」')
    expect(warned).toContain('重复同名顶层键「标签」')
    expect(warned).toContain('已丢弃')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R51-F-7b: 无重复键不触发 warn（warn 面不扩大）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const r = patchFlatFm('标题: 旧书名', { 标题: '新书名' })
    expect(r.ok).toBe(true)
    expect(warnSpy).not.toHaveBeenCalled()
  } finally {
    warnSpy.mockRestore()
  }
})
