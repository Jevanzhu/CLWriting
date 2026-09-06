/**
 * 正文排版预设（F 线 2026-09-05 作者指令：不做默认翻转，做预设组合一键切换——
 * 「在字体那增加一个预设选项，几种我们预设好的组合选择」）。预设组演进：
 * 两套（只留好看）→ 四套（按「右边的好点」补思源黑体/宋体）→ 2026-09-05 白底
 * 锐度专项后作者判定「思源宋白底糊是字体本体原因」（横细画 + 弱 hinting，F0b
 * ClearType 回归后显形）——默认预设字体槽改雅黑（作者样张「C 不错」唯一亲验
 * 正本体），与出厂空槽（衬线栈）脱钩；「无衬线 · 清爽」与默认重复随之移除。
 * 2026-09-05②（高优先三件收口）：① 预设补齐英文配对槽——雅黑/思源黑挂 Segoe UI，
 * 拉丁不再走 CJK 自带字形；② 光学等效字号试调——思源黑字面率大 17→16（2026-09-06⑤
 * 视评回 17）；③ 回退栈按中文字体族归边（衬线/书卷 vs 无衬线，见 useSystemFonts
 * proseFallbackTail）——修「思源黑体预设未装 Noto 时正文静默落宋体」跨族翻转。
 * 2026-09-06③：宋体·经典预设移除——SimSun 老式 hinting，白底偏薄偏糊系字体本体
 * 难救（F0c 判定同源）；手动字槽仍可选宋体、衬线回退栈仍在，仅不占预设位。
 * 2026-09-06⑤：作者视评——思源黑 16px 显丑，字号回 17、行距 1.6→1.5；两套预设现
 * 同档（17/1.5）仅字体不同，光学等效差值不作预设基准。
 *
 * 每个预设 = 正文中英字体槽 + 字号 + 行距的命名组合，值与 prefs prose* 四字段
 * 一一对应：应用即逐项走既有 setter（setSize/setLh/setProseFontCn/setProseFontEn），
 * 零新持久化键；激活态 = 四字段与某预设的派生判断，全不匹配即「自定义」。
 *
 * 字体槽留空 = 沿用默认栈（tokens.css --prose-font，衬线：霞鹜文楷→思源宋→宋体）；
 * 预设指名的字体未安装时经 proseFallbackTail 分族基座优雅回落（如文楷未装回落
 * 宋体、思源黑未装回落雅黑），不空窗。字号/行距均在设置滑杆钳制域内（13-24 / 1.4-2.4）。
 * 2026-09-06④：字体身份匹配改为族键比对（zh/en 异名、思源/Noto 双产品同族，见
 * font-names.ts）——点击预设按已装候补落地（resolveInstalledFont），激活态派生
 * 判断同口径（canonicalFontName），「微软雅黑/思源黑体」等异名不再失配。
 */

import { canonicalFontName } from './font-names'

export interface ProsePresetValues {
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

/** 预设工厂：desc 的「（Npx · M）」尾缀由 values 派生（2026-09-06⑥）——改档只改
 *  values 一处，desc 永不漂移（此前 16→17 曾连改两处）。 */
function preset(id: string, label: string, wording: string, values: ProsePresetValues): ProsePreset {
  return { id, label, desc: `${wording}（${values.proseSize}px · ${values.proseLh}）`, values }
}

export const PROSE_PRESETS: ProsePreset[] = [
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

/** 当前排版态命中的预设 id；四字段无同族命中即 'custom'（派生值，不持久化）。
 *  字体槽按族键比对（font-names.ts）：异名同族（微软雅黑/思源黑体等）也命中。 */
export function matchProsePreset(v: ProsePresetValues): string {
  const hit = PROSE_PRESETS.find(
    (p) =>
      canonicalFontName(p.values.proseFontCn) === canonicalFontName(v.proseFontCn) &&
      canonicalFontName(p.values.proseFontEn) === canonicalFontName(v.proseFontEn) &&
      p.values.proseSize === v.proseSize &&
      p.values.proseLh === v.proseLh,
  )
  return hit?.id ?? 'custom'
}
