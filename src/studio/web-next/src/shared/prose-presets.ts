/**
 * 正文排版预设（预设组合一键切换，不做默认翻转）。
 *
 * 每个预设 = 正文中英字体槽 + 字号 + 行距的命名组合，值与 prefs prose* 四字段一一对应：应用
 * 即逐项走既有 setter（setSize/setLh/setProseFontCn/setProseFontEn），零新持久化键；激活态
 * = 四字段与某预设的派生判断，全不匹配即「自定义」。
 *
 * 字体槽留空 = 沿用默认栈（tokens.css --prose-font 平台块）；预设指名的字体未安装时经
 * proseFallbackTail 分族基座优雅回落（如文楷未装回落宋体、思源黑未装回落雅黑/苹方），不空窗。
 * 字号/行距均在设置滑杆钳制域内（13-24 / 1.4-2.4）。
 * 平台拆分：win 组用雅黑/思源黑 + Segoe UI 英文槽；mac 组用恒装族（苹方/宋体-简/冬青黑体），
 * 英文槽留空让拉丁走系统 SF。宋体不进 win 预设位（SimSun 老式 hinting，白底偏薄偏糊系字体
 * 本体难救；手动字槽仍可选宋体）；mac 侧「宋体 · 书卷」无此问题（Songti SC 是现代矢量渲染）。
 * 字体身份匹配按族键比对（zh/en 异名、思源/Noto 双产品同族，见 font-names.ts）——点击预设按
 * 已装候补落地（resolveInstalledFont），激活态派生同口径（canonicalFontName），异名不失配。
 */

import { canonicalFontName } from './font-names'
import { usePlatform } from '../composables/usePlatform'

interface ProsePresetValues {
  proseFontCn: string
  proseFontEn: string
  proseSize: number
  proseLh: number
}

export interface ProsePreset {
  id: string
  label: string
  desc: string
  values: ProsePresetValues
}

/** 预设工厂：desc 的「（Npx · M）」尾缀由 values 派生（⑥）——改档只改
 *  values 一处，desc 永不漂移（此前 16→17 曾连改两处）。 */
function preset(id: string, label: string, wording: string, values: ProsePresetValues): ProsePreset {
  return { id, label, desc: `${wording}（${values.proseSize}px · ${values.proseLh}）`, values }
}

/** 预设组·win（雅黑 = 作者「C 不错」唯一亲验本体；思源黑跨平台可自装） */
export const PROSE_PRESETS_WIN: ProsePreset[] = [
  preset('default', '默认 · 雅黑', '微软雅黑 + Segoe UI，屏显最稳', {
    proseFontCn: 'Microsoft YaHei',
    proseFontEn: 'Segoe UI',
    proseSize: 17,
    proseLh: 1.5,
  }),
  preset('noto-sans', '思源黑体 · 均衡', '思源黑体（Noto Sans SC），字面方正现代', {
    proseFontCn: 'Noto Sans SC',
    proseFontEn: 'Segoe UI',
    proseSize: 17,
    proseLh: 1.5,
  }),
]

/** 预设组·mac：三套均 mac 恒装族（苹方/冬青黑体/宋体-简），无「未装」
 *  形态；冬青居中（作者拍板：无衬线两档相邻，衬线书卷收尾）。英文槽留空——拉丁走
 *  回退尾 -apple-system（SF），对齐 UI_DEFAULT_STACK.mac.en 先例 */
export const PROSE_PRESETS_MAC: ProsePreset[] = [
  preset('default', '默认 · 苹方', '苹方（PingFang SC）+ 系统拉丁（SF），屏显最稳', {
    proseFontCn: 'PingFang SC',
    proseFontEn: '',
    proseSize: 17,
    proseLh: 1.5,
  }),
  preset('hiragino', '冬青黑体 · 修长', '冬青黑体（Hiragino Sans GB），字面修长雅致', {
    proseFontCn: 'Hiragino Sans GB',
    proseFontEn: '',
    proseSize: 17,
    proseLh: 1.5,
  }),
  preset('songti', '宋体 · 书卷', '宋体-简（Songti SC），衬线书卷质感', {
    proseFontCn: 'Songti SC',
    proseFontEn: '',
    proseSize: 17,
    proseLh: 1.5,
  }),
]

/** 当前平台预设组（SettingsEditor 渲染用；浏览器预览态走 mac 组，与默认栈/回退尾
 *  同口径——tokens.css :root 即 mac 观感基准）。 */
export function prosePresets(): ProsePreset[] {
  return usePlatform().isWin ? PROSE_PRESETS_WIN : PROSE_PRESETS_MAC
}

/** 当前排版态命中的预设 id；四字段无同族命中即 'custom'（派生值，不持久化）。
 *  字体槽按族键比对（font-names.ts）：异名同族（微软雅黑/思源黑体等）也命中。
 * 平台分流：只对当前平台组匹配——他平台预设值（如 mac 上存过
 *  雅黑四字段）不误命中本平台同 id 预设（default 两平台字体不同）。 */
export function matchProsePreset(v: ProsePresetValues): string {
  const hit = prosePresets().find(
    (p) =>
      canonicalFontName(p.values.proseFontCn) === canonicalFontName(v.proseFontCn) &&
      canonicalFontName(p.values.proseFontEn) === canonicalFontName(v.proseFontEn) &&
      p.values.proseSize === v.proseSize &&
      p.values.proseLh === v.proseLh,
  )
  return hit?.id ?? 'custom'
}
