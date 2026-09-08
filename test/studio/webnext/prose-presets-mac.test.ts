// @vitest-environment happy-dom
/**
 * mac 预设批（2026-09-08）· mac 腿单测：预设组/回退尾/默认栈按平台分流的 mac 侧
 * （win 腿见 prose-presets.test.ts / font-picker.test.ts，两文件文件级 mock isWin）。
 * 覆盖：matchProsePreset mac 命中与跨组不误命中、本地化族键（宋体-简/苹方-简）、
 * proseFallbackTail mac 双族尾、useSystemFonts 默认栈 mac 解析、tokens.css darwin
 * 块 --prose-font 与 TS 常量同源（防双源漂移）。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

vi.mock('../../../src/studio/web-next/src/composables/usePlatform', () => ({
  usePlatform: () => ({ isDesktop: true, platform: 'darwin', isMac: true, isWin: false }),
}))

import { matchProsePreset, prosePresets } from '../../../src/studio/web-next/src/shared/prose-presets'
import {
  useSystemFonts,
  proseDefaultStack,
  PROSE_FONT_FALLBACK_MAC,
  PROSE_FONT_SANS_FALLBACK_MAC,
  isSerifCnFont,
  proseFallbackTail,
} from '../../../src/studio/web-next/src/composables/useSystemFonts'
import { isFontInstalled, resolveInstalledFont } from '../../../src/studio/web-next/src/shared/font-names'

const PINGFANG = { proseFontCn: 'PingFang SC', proseFontEn: '', proseSize: 17, proseLh: 1.5 }
const SONGTI = { proseFontCn: 'Songti SC', proseFontEn: '', proseSize: 17, proseLh: 1.5 }
const HIRAGINO = { proseFontCn: 'Hiragino Sans GB', proseFontEn: '', proseSize: 17, proseLh: 1.5 }

describe('mac 腿：预设组平台分流', () => {
  it('prosePresets() 出 mac 组（default 苹方 / hiragino 冬青黑体居中 / songti 宋体-简收尾）', () => {
    expect(prosePresets().map((p) => p.id)).toEqual(['default', 'hiragino', 'songti'])
  })

  it('matchProsePreset mac 命中：苹方/宋体/冬青四字段各自命中；出厂空槽落「自定义」', () => {
    expect(matchProsePreset({ ...PINGFANG })).toBe('default')
    expect(matchProsePreset({ ...SONGTI })).toBe('songti')
    expect(matchProsePreset({ ...HIRAGINO })).toBe('hiragino')
    expect(matchProsePreset({ proseFontCn: '', proseFontEn: '', proseSize: 17, proseLh: 1.5 })).toBe('custom')
  })

  it('跨组不误命中：win 预设四字段（雅黑/思源黑 + Segoe UI）在 mac 平台落「自定义」——default 两平台字体不同，不误亮本平台 chip', () => {
    expect(matchProsePreset({ proseFontCn: 'Microsoft YaHei', proseFontEn: 'Segoe UI', proseSize: 17, proseLh: 1.5 })).toBe('custom')
    expect(matchProsePreset({ proseFontCn: 'Noto Sans SC', proseFontEn: 'Segoe UI', proseSize: 17, proseLh: 1.5 })).toBe('custom')
  })

  it('mac 本地化族键：zh 系统 font-list 枚举名（苹方-简/宋体-简/楷体-简/冬青黑体简体中文）与英文名同族互认', () => {
    expect(matchProsePreset({ ...PINGFANG, proseFontCn: '苹方-简' })).toBe('default')
    expect(matchProsePreset({ ...SONGTI, proseFontCn: '宋体-简' })).toBe('songti')
    expect(matchProsePreset({ ...HIRAGINO, proseFontCn: '冬青黑体简体中文' })).toBe('hiragino')
    // 已装判定：本地化枚举形态不再误报未装
    expect(isFontInstalled(['宋体-简', '苹方-简'], 'Songti SC')).toBe(true)
    expect(isFontInstalled(['宋体-简', '苹方-简'], 'PingFang SC')).toBe(true)
    expect(isFontInstalled(['冬青黑体简体中文'], 'Hiragino Sans GB')).toBe(true)
    expect(isFontInstalled(['宋体-简'], 'Kaiti SC')).toBe(false)
    // 候补落地：族已装取系统实际名（CSS 直接命中）；英文名在装取英文名
    expect(resolveInstalledFont(['宋体-简'], 'Songti SC')).toBe('宋体-简')
    expect(resolveInstalledFont(['Songti SC'], 'Songti SC')).toBe('Songti SC')
    expect(resolveInstalledFont(['冬青黑体简体中文'], 'Hiragino Sans GB')).toBe('冬青黑体简体中文')
  })
})

describe('mac 腿：回退尾与默认栈', () => {
  it('proseFallbackTail mac 分支——衬线/书卷族（含宋体-简/楷体-简）挂 mac 衬线尾，其余（苹方/冬青黑/win 无衬线族）挂 mac 无衬线尾', () => {
    expect(proseFallbackTail('')).toBe(PROSE_FONT_FALLBACK_MAC)
    expect(proseFallbackTail('Songti SC')).toBe(PROSE_FONT_FALLBACK_MAC)
    expect(proseFallbackTail('Kaiti SC')).toBe(PROSE_FONT_FALLBACK_MAC)
    expect(proseFallbackTail('LXGW WenKai')).toBe(PROSE_FONT_FALLBACK_MAC)
    expect(proseFallbackTail('PingFang SC')).toBe(PROSE_FONT_SANS_FALLBACK_MAC)
    expect(proseFallbackTail('Hiragino Sans GB')).toBe(PROSE_FONT_SANS_FALLBACK_MAC)
    expect(proseFallbackTail('Microsoft YaHei')).toBe(PROSE_FONT_SANS_FALLBACK_MAC)
  })

  it('mac 双族尾值锁定：衬线尾落宋体-简（不再经 win 死名裸落 serif 兜底）；无衬线尾 -apple-system 居首让拉丁走 SF', () => {
    expect(PROSE_FONT_FALLBACK_MAC).toBe("'LXGW WenKai', 'Songti SC', serif")
    expect(PROSE_FONT_SANS_FALLBACK_MAC).toBe("-apple-system, 'PingFang SC', 'Hiragino Sans GB', sans-serif")
  })

  it('isSerifCnFont mac 族分类：宋体-简/楷体-简归衬线，苹方/黑体-简/冬青黑归无衬线', () => {
    expect(isSerifCnFont('Songti SC')).toBe(true)
    expect(isSerifCnFont('Kaiti SC')).toBe(true)
    expect(isSerifCnFont('PingFang SC')).toBe(false)
    expect(isSerifCnFont('Heiti SC')).toBe(false)
    expect(isSerifCnFont('Hiragino Sans GB')).toBe(false)
  })

  it('默认栈 mac：proseDefaultStack = 霞鹜文楷→宋体-简（mac 恒装兜底）；useSystemFonts 按实装收敛、本地化名经族键命中', () => {
    expect(proseDefaultStack()).toEqual(['LXGW WenKai', 'Songti SC'])
    const { systemFonts, defaultProseFontCn, defaultProseFontEn } = useSystemFonts()
    // 列表空 → 栈首（mac 常态必有 Songti SC，此为 IPC 未回时的兜底形态）
    expect(defaultProseFontCn.value).toBe('LXGW WenKai')
    expect(defaultProseFontEn.value).toBe('LXGW WenKai')
    // 本地化枚举名「宋体-简」经族键判定已装 → 命中栈成员 'Songti SC'（resolveDefault
    // 契约：返回栈成员名——CSS 按英文名直命中 mac CoreText；无族键时整组 miss 退栈首
    // LXGW。「取系统实际名」是 resolveInstalledFont〔点击预设时〕的契约，两者分工）
    systemFonts.value = ['宋体-简', '苹方-简']
    expect(defaultProseFontCn.value).toBe('Songti SC')
    // 英文名在装取英文名
    systemFonts.value = ['Songti SC', 'PingFang SC']
    expect(defaultProseFontCn.value).toBe('Songti SC')
  })

  it('tokens.css darwin 块 --prose-font 与 PROSE_FONT_FALLBACK_MAC 同源（双源防漂移）', () => {
    const tokensPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../src/studio/web-next/src/styles/tokens.css',
    )
    const css = readFileSync(tokensPath, 'utf8')
    const expected = `--prose-font: ${PROSE_FONT_FALLBACK_MAC};`
    expect(css).toContain(expected)
  })
})
