/**
 * 正文排版预设（prose-presets.ts）单测（F 线 2026-09-05 作者指令「增加预设选项，
 * 几种预设好的组合」）：激活态派生匹配 + 预设值不变式（滑杆钳制域 / id 唯一 /
 * 默认预设 = 出厂值）。
 */
import { describe, expect, it } from 'vitest'
import { PROSE_PRESETS, matchProsePreset } from '../../../src/studio/web-next/src/shared/prose-presets'

const FACTORY = { proseFontCn: '', proseFontEn: '', proseSize: 17, proseLh: 1.5 }

describe('正文排版预设', () => {
  it('预设 id 唯一且非空、标签/描述齐备', () => {
    const ids = PROSE_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of PROSE_PRESETS) {
      expect(p.id).toBeTruthy()
      expect(p.label).toBeTruthy()
      expect(p.desc).toBeTruthy()
    }
  })

  it('预设组 = 作者拍板的三套（默认·雅黑 / 思源黑体·均衡 / 宋体·经典；无衬线·清爽与默认重复已移除）', () => {
    const ids = PROSE_PRESETS.map((p) => p.id).sort()
    expect(ids).toEqual(['default', 'noto-sans', 'songti'])
  })

  it('预设值均在设置滑杆钳制域内（字号 13-24 / 行距 1.4-2.4）', () => {
    for (const p of PROSE_PRESETS) {
      expect(p.values.proseSize).toBeGreaterThanOrEqual(13)
      expect(p.values.proseSize).toBeLessThanOrEqual(24)
      expect(p.values.proseLh).toBeGreaterThanOrEqual(1.4)
      expect(p.values.proseLh).toBeLessThanOrEqual(2.4)
    }
  })

  it('默认预设 = 雅黑定档（作者「C 不错」唯一亲验本体；出厂空槽衬线态脱钩落「自定义」）', () => {
    const def = PROSE_PRESETS.find((p) => p.id === 'default')
    expect(def).toBeTruthy()
    expect(def!.values).toEqual({
      proseFontCn: 'Microsoft YaHei',
      proseFontEn: '',
      proseSize: 17,
      proseLh: 1.5,
    })
    expect(matchProsePreset(FACTORY)).toBe('custom')
  })

  it('四字段全等才命中：每个预设可被自身值命中', () => {
    for (const p of PROSE_PRESETS) {
      expect(matchProsePreset({ ...p.values })).toBe(p.id)
    }
  })

  it('任一字段偏离即落「自定义」（字号/行距/字体三轴各验一例）', () => {
    expect(matchProsePreset({ ...FACTORY, proseSize: 17.5 })).toBe('custom')
    expect(matchProsePreset({ ...FACTORY, proseLh: 1.55 })).toBe('custom')
    expect(matchProsePreset({ ...FACTORY, proseFontCn: 'SimHei' })).toBe('custom')
  })

  it('预设只动声明字段：默认预设 CN=雅黑且 EN 槽留空（拉丁由 CJK 字体自带）', () => {
    const def = PROSE_PRESETS.find((p) => p.id === 'default')!
    expect(def.values.proseFontEn).toBe('')
  })
})
