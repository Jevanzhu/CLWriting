/**
 * 0918三轮修复批（A201）回归：knowledge 注入进「模型可见 ⟺ 已记录」校验链。
 *
 * 修复前 0917 扩登记面（knowledge 血缘事件）时校验面三处未同步——visibleInjections /
 * visibleInjectionsFromDigests / verifyVisibleSampled 签名均无 knowledge 档：knowledge
 * 注入进 prompt 但可见清单无此档，CLW_VERIFY_VISIBLE 抽样校验对该通道失明（TS 结构化
 * 类型对多余属性不报错，knowledge 静默蒸发、抽样永远 silent-pass）。修复后三处贯通。
 *
 * 独立新件缘由：verify-visible-sampled.test.ts 既有用例只盖 settings/revision/skills
 * 三档正向面；本件补 knowledge 档贯通 + 缺登记 warn 面。锚：0918三轮修复批 A201。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verifyVisibleSampled } from '../../src/ai/orchestrate/chat/turns-visibility.js'
import { visibleInjectionsFromDigests } from '../../src/ai/prompts/chat.js'

const D = {
  settings: 'dg-settings-01',
  revision: 'dg-revision-01',
  skills: 'dg-skills-01',
  knowledge: 'dg-knowledge-01',
}
// knowledge 登记事件形状 = settingsSnapshotEvent({ scope: 'knowledge', digest })（turns.ts 同源）
const recorded = [
  { type: 'settings/snapshot', data: { scope: 'settings', digest: D.settings } },
  { type: 'revision/ref', data: { revision: D.revision } },
  { type: 'skills/snapshot', data: { scope: 'skills', digest: D.skills } },
  { type: 'settings/snapshot', data: { scope: 'knowledge', digest: D.knowledge } },
] as Parameters<typeof verifyVisibleSampled>[1]

beforeEach(() => delete process.env['CLW_VERIFY_VISIBLE'])
afterEach(() => {
  delete process.env['CLW_VERIFY_VISIBLE']
  vi.restoreAllMocks()
})

describe('A201（0918三轮修复批）：knowledge 进可见性校验链', () => {
  it('flag 开 + knowledge 注入已登记 → 不 warn（四档可见清单全数对账）', () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyVisibleSampled(D, recorded)
    expect(warn).not.toHaveBeenCalled()
  })

  it('flag 开 + knowledge 可见但未登记 → warn 缺失清单含 knowledge:<digest>（修复前静默失明面）', () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyVisibleSampled(D, recorded.slice(0, 3))
    expect(warn).toHaveBeenCalledTimes(1)
    const msg = String(warn.mock.calls[0]?.[0])
    expect(msg).toContain('[CLW_VERIFY_VISIBLE]')
    expect(msg).toContain(`knowledge:${D.knowledge}`)
    expect(msg).toContain('1/4')
  })

  it('knowledge 未注入（undefined）→ 不进可见清单、不算缺失（条件注入口径）', () => {
    process.env['CLW_VERIFY_VISIBLE'] = '1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    verifyVisibleSampled({ settings: D.settings, revision: D.revision, skills: D.skills }, recorded.slice(0, 3))
    expect(warn).not.toHaveBeenCalled()
  })

  it('visibleInjectionsFromDigests 单源形状：knowledge 档产出 {scope:"knowledge"}（settings 恒在、未传不出）', () => {
    expect(visibleInjectionsFromDigests({ settings: D.settings, knowledge: D.knowledge })).toEqual([
      { scope: 'settings', digest: D.settings },
      { scope: 'knowledge', digest: D.knowledge },
    ])
    expect(visibleInjectionsFromDigests({ settings: D.settings })).toEqual([{ scope: 'settings', digest: D.settings }])
  })
})
