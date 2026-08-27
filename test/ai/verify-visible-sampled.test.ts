/**
 * R65-15（十三轮批 A）回归：verifyVisibleSampled 诊断开关（「模型可见 ⟺ 已记录」生产侧抽查）。
 * - flag 关（默认）：首行即返回，零开销（不 warn）
 * - flag 开 + 登记齐全：不 warn
 * - flag 开 + 有缺失：console.warn 列出 scope:digest
 * - 校验通道自身异常：吞掉不外溢（硬约束——不影响主流程）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verifyVisibleSampled } from '../../src/ai/orchestrate/chat/turns.js'

const D = { settings: 'dg-settings-01', revision: 'dg-revision-01', skills: 'dg-skills-01' }
const recorded = [
  { type: 'settings/snapshot', data: { scope: 'settings', digest: D.settings } },
  { type: 'revision/ref', data: { revision: D.revision } },
  { type: 'skills/snapshot', data: { scope: 'skills', digest: D.skills } }, // 归一化取 data.scope
] as Parameters<typeof verifyVisibleSampled>[1]

beforeEach(() => delete process.env['CLW_VERIFY_VISIBLE'])
afterEach(() => {
  delete process.env['CLW_VERIFY_VISIBLE']
  vi.restoreAllMocks()
})

describe('verifyVisibleSampled（R65-15）', () => {
  it('flag 关 → 即便登记缺失也不 warn（零开销）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 空登记：若误跑校验必命中缺失
    verifyVisibleSampled(D, [])
    expect(warn).not.toHaveBeenCalled()
  })

  it('flag 开 + 三种登记形状齐全（settings/snapshot、revision/ref、skills/snapshot）→ 不 warn', () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyVisibleSampled(D, recorded)
    expect(warn).not.toHaveBeenCalled()
  })

  it('flag 开 + 缺 revision 登记 → warn 带缺失清单；不影响其余 present', () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyVisibleSampled(D, recorded.filter((e: { type: string }) => e.type !== 'revision/ref') as Parameters<typeof verifyVisibleSampled>[1])
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]?.[0])
    expect(msg).toContain('[CLW_VERIFY_VISIBLE]')
    expect(msg).toContain(`chapter:${D.revision}`)
    expect(msg).toContain('1/3') // 3 项可见注入缺 1
  })

  it('可选 digest 未注入时不进入可见清单（undefined 的 revision/skills 不算缺失）', () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 只声明 settings，且只登记 settings —— 完备
    verifyVisibleSampled({ settings: D.settings }, [
      { type: 'settings/snapshot', data: { scope: 'settings', digest: D.settings } },
    ] as Parameters<typeof verifyVisibleSampled>[1])
    expect(warn).not.toHaveBeenCalled()
  })
})
