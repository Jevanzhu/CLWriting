/**
 * 中文字体族名对齐（2026-09-06，win 字体 F 线④）。
 *
 * 背景：win 字体枚举（win-fonts.ts PS 脚本）按 font-list 口径 zh-cn 族名优先、
 * en-us 兜底——中文系统列表里是「微软雅黑/宋体/等线…」，而预设/默认栈存的是英文
 * 族名「Microsoft YaHei/SimSun…」。同一款字体的两个名字在字符串比对下互为「未装」
 * （「默认·雅黑」chip 曾误报未装）；思源/Noto 双产品系同理（思源黑体 = Source Han
 * Sans SC 与 Google Noto Sans SC 是两个产品名，CSS 互不匹配）。
 *
 * 解法：规范族键（CN_FONT_CANON）——同族异名归一键；已装判定、预设身份匹配、
 * 点击预设时的候补落地三处共用，保证「徽标不误报、预览如实回退、点击即渲染真字体」。
 * 未知字体规范键 = 自身，零退化。
 */

/** 中文字体异名 → 规范族键（zh/en 同字体、思源/Noto 同族双产品） */
export const CN_FONT_CANON: Record<string, string> = {
  // 微软雅黑（win 恒装；zh-cn 枚举名与 en 名）
  'Microsoft YaHei': 'msyh',
  微软雅黑: 'msyh',
  // 微软雅黑 UI 是独立度量变体（UI 栈用），与雅黑本体分键
  'Microsoft YaHei UI': 'msyh-ui',
  // 宋体 / 新宋体 / 黑体 / 等线 / 楷体 / 仿宋（zh-en 同字）
  SimSun: 'simsun',
  宋体: 'simsun',
  NSimSun: 'nsimsun',
  新宋体: 'nsimsun',
  SimHei: 'simhei',
  黑体: 'simhei',
  DengXian: 'dengxian',
  等线: 'dengxian',
  KaiTi: 'kaiti',
  楷体: 'kaiti',
  FangSong: 'fangsong',
  仿宋: 'fangsong',
  // 思源黑/宋体（Adobe Source Han 与 Google Noto 双产品名 + zh 名）
  'Noto Sans SC': 'sans-sc',
  'Source Han Sans SC': 'sans-sc',
  思源黑体: 'sans-sc',
  'Noto Serif SC': 'serif-sc',
  'Source Han Serif SC': 'serif-sc',
  思源宋体: 'serif-sc',
  // 霞鹜文楷 / 苹方
  'LXGW WenKai': 'wenkai',
  霞鹜文楷: 'wenkai',
  'PingFang SC': 'pingfang',
  苹方: 'pingfang',
}

/** 异名 → 规范族键；未知字体 = 自身 */
export function canonicalFontName(name: string): string {
  return CN_FONT_CANON[name] ?? name
}

/** 已装判定：族名或其任意异名形态出现在系统列表即算已装（列表侧同样过规范键） */
export function isFontInstalled(installed: readonly string[], name: string): boolean {
  if (!name) return false
  const key = canonicalFontName(name)
  return installed.some((f) => canonicalFontName(f) === key)
}

/** 预设指名字体 → 可落地候补（按优先序；zh-cn 系统常见的 Adobe/中文名形态） */
export const PROSE_FONT_COGNATES: Record<string, string[]> = {
  'Noto Sans SC': ['Noto Sans SC', 'Source Han Sans SC', '思源黑体'],
  'Noto Serif SC': ['Noto Serif SC', 'Source Han Serif SC', '思源宋体'],
  'Microsoft YaHei': ['Microsoft YaHei', '微软雅黑'],
  SimSun: ['SimSun', '宋体'],
  'LXGW WenKai': ['LXGW WenKai', '霞鹜文楷'],
}

/** 落地解析：返回系统里第一个已装候补的**实际族名**（点击预设时存进 proseFontCn，
 *  CSS 直接命中真字体）。族已装但候补名都不是字面（如 zh 系统只有「思源黑体」）→
 *  返回列表里该族的实际名字；族全未装返回原名（回退链兜底，与现状一致）。 */
export function resolveInstalledFont(installed: readonly string[], name: string): string {
  if (!name) return ''
  const candidates = PROSE_FONT_COGNATES[name] ?? [name]
  if (!candidates.some((c) => isFontInstalled(installed, c))) return name
  // 候补序中字面命中的名字（CSS 必然命中；如 Noto Sans SC 真装时）
  const literal = candidates.find((c) => installed.includes(c))
  if (literal) return literal
  // 族已装但候选名都不字面：取列表里该族的实际名字（如 zh 枚举的「思源黑体」）
  return installed.find((f) => candidates.some((c) => canonicalFontName(c) === canonicalFontName(f))) ?? name
}