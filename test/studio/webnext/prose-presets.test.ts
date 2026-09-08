/**
 * 正文排版预设（prose-presets.ts）单测（F 线 2026-09-05 作者指令「增加预设选项，
 * 几种预设好的组合」）：激活态派生匹配 + 预设值不变式（滑杆钳制域 / id 唯一 /
 * 默认预设 = 出厂值）。2026-09-05② 追加：英文配对槽 + 光学等效字号锁定。
 * 2026-09-08 mac 预设批：预设组双平台拆分——本文件锁 win 组（文件级 mock
 * usePlatform isWin=true，matchProsePreset/prosePresets 平台分流的 win 腿）；
 * mac 组常量与 mac 腿分流见 prose-presets-mac.test.ts。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isDesktop: true, platform: 'win32', isMac: false, isWin: true }),
}))

import { PROSE_PRESETS_WIN, PROSE_PRESETS_MAC, matchProsePreset } from '../../../src/studio/web-next/src/shared/prose-presets'

const PROSE_PRESETS = PROSE_PRESETS_WIN
const FACTORY = { proseFontCn: '', proseFontEn: '', proseSize: 17, proseLh: 1.5 }

describe('正文排版预设（win 组）', () => {
  it('预设 id 唯一且非空、标签/描述齐备（两平台组同律）', () => {
    for (const group of [PROSE_PRESETS_WIN, PROSE_PRESETS_MAC]) {
      const ids = group.map((p) => p.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const p of group) {
        expect(p.id).toBeTruthy()
        expect(p.label).toBeTruthy()
        expect(p.desc).toBeTruthy()
      }
    }
  })

  it('预设组 = 作者拍板的两套（默认·雅黑 / 思源黑体·均衡；宋体·经典 2026-09-06 移除，无衬线·清爽早已并默认）', () => {
    const ids = PROSE_PRESETS.map((p) => p.id).sort()
    expect(ids).toEqual(['default', 'noto-sans'])
  })

  it('预设值均在设置滑杆钳制域内（字号 13-24 / 行距 1.4-2.4；两平台组同律）', () => {
    for (const group of [PROSE_PRESETS_WIN, PROSE_PRESETS_MAC]) {
      for (const p of group) {
        expect(p.values.proseSize).toBeGreaterThanOrEqual(13)
        expect(p.values.proseSize).toBeLessThanOrEqual(24)
        expect(p.values.proseLh).toBeGreaterThanOrEqual(1.4)
        expect(p.values.proseLh).toBeLessThanOrEqual(2.4)
      }
    }
  })

  it('默认预设 = 雅黑定档（作者「C 不错」唯一亲验本体；出厂空槽衬线态脱钩落「自定义」）', () => {
    const def = PROSE_PRESETS.find((p) => p.id === 'default')
    expect(def).toBeTruthy()
    expect(def!.values).toEqual({
      proseFontCn: 'Microsoft YaHei',
      proseFontEn: 'Segoe UI',
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

  it('两套预设 EN 槽一律配对拉丁（雅黑→Segoe UI / 思源黑→Segoe UI；拉丁不再走 CJK 自带字形）', () => {
    const en = Object.fromEntries(PROSE_PRESETS.map((p) => [p.id, p.values.proseFontEn]))
    expect(en).toEqual({ default: 'Segoe UI', 'noto-sans': 'Segoe UI' })
  })

  it('两套预设同档字号/行距（17px · 1.5）：思源黑与雅黑无档差（2026-09-06⑤ 视评回 17）', () => {
    const size = Object.fromEntries(PROSE_PRESETS.map((p) => [p.id, p.values.proseSize]))
    const lh = Object.fromEntries(PROSE_PRESETS.map((p) => [p.id, p.values.proseLh]))
    expect(size).toEqual({ default: 17, 'noto-sans': 17 })
    expect(lh).toEqual({ default: 1.5, 'noto-sans': 1.5 })
  })

  it('宋体·经典已移除：SimSun/Georgia/18/1.6 组合落「自定义」，不再有预设命中', () => {
    expect(matchProsePreset({ proseFontCn: 'SimSun', proseFontEn: 'Georgia', proseSize: 18, proseLh: 1.6 })).toBe('custom')
    expect(PROSE_PRESETS.some((p) => p.values.proseFontCn === 'SimSun')).toBe(false)
  })

  it('族键身份匹配：异名同族命中（zh 中文名、思源/Noto 双产品均归同族）', () => {
    expect(matchProsePreset({ proseFontCn: '微软雅黑', proseFontEn: 'Segoe UI', proseSize: 17, proseLh: 1.5 })).toBe('default')
    expect(matchProsePreset({ proseFontCn: '思源黑体', proseFontEn: 'Segoe UI', proseSize: 17, proseLh: 1.5 })).toBe('noto-sans')
    expect(matchProsePreset({ proseFontCn: 'Source Han Sans SC', proseFontEn: 'Segoe UI', proseSize: 17, proseLh: 1.5 })).toBe('noto-sans')
    // 异族不误命中
    expect(matchProsePreset({ proseFontCn: 'SimHei', proseFontEn: 'Segoe UI', proseSize: 17, proseLh: 1.5 })).toBe('custom')
  })
})

describe('mac 预设组常量（2026-09-08；平台分流腿见 prose-presets-mac.test.ts）', () => {
  it('mac 组 = 苹方默认 + 冬青黑体居中 + 宋体书卷收尾（mac 恒装族，无「未装」形态；冬青 2026-09-08 作者追加并拍板居中）', () => {
    expect(PROSE_PRESETS_MAC.map((p) => p.id)).toEqual(['default', 'hiragino', 'songti'])
  })

  it('mac 默认预设 = 苹方定档（英文槽留空走系统 SF，对齐 UI_DEFAULT_STACK.mac.en 先例）', () => {
    const def = PROSE_PRESETS_MAC.find((p) => p.id === 'default')
    expect(def).toBeTruthy()
    expect(def!.values).toEqual({
      proseFontCn: 'PingFang SC',
      proseFontEn: '',
      proseSize: 17,
      proseLh: 1.5,
    })
    const songti = PROSE_PRESETS_MAC.find((p) => p.id === 'songti')
    expect(songti!.values).toEqual({
      proseFontCn: 'Songti SC',
      proseFontEn: '',
      proseSize: 17,
      proseLh: 1.5,
    })
    const hiragino = PROSE_PRESETS_MAC.find((p) => p.id === 'hiragino')
    expect(hiragino!.values).toEqual({
      proseFontCn: 'Hiragino Sans GB',
      proseFontEn: '',
      proseSize: 17,
      proseLh: 1.5,
    })
  })

  it('mac 组同档 17/1.5 与 win 对齐（mac 视评后再调，desc 尾缀由工厂派生不漂移）', () => {
    for (const p of PROSE_PRESETS_MAC) {
      expect(p.values.proseSize).toBe(17)
      expect(p.values.proseLh).toBe(1.5)
      expect(p.desc).toContain('（17px · 1.5）')
    }
  })

  it('mac 组不残留 win 族（雅黑/思源黑/Segoe UI 均不在 mac 预设槽）', () => {
    for (const p of PROSE_PRESETS_MAC) {
      expect(p.values.proseFontCn).not.toMatch(/YaHei|Noto|SimSun|DengXian|SimHei/)
      expect(p.values.proseFontEn).not.toBe('Segoe UI')
    }
  })
})
