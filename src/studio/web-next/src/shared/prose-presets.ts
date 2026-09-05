/**
 * 正文排版预设（F 线 2026-09-05 作者指令：不做默认翻转，做预设组合一键切换——
 * 「在字体那增加一个预设选项，几种我们预设好的组合选择」）。预设组演进：
 * 两套（只留好看）→ 四套（按「右边的好点」补思源黑体/宋体）→ 2026-09-05 白底
 * 锐度专项后作者判定「思源宋白底糊是字体本体原因」（横细画 + 弱 hinting，F0b
 * ClearType 回归后显形）——默认预设字体槽改雅黑（作者样张「C 不错」唯一亲验
 * 正本体），与出厂空槽（衬线栈）脱钩；「无衬线 · 清爽」与默认重复随之移除。
 *
 * 每个预设 = 正文中英字体槽 + 字号 + 行距的命名组合，值与 prefs prose* 四字段
 * 一一对应：应用即逐项走既有 setter（setSize/setLh/setProseFontCn/setProseFontEn），
 * 零新持久化键；激活态 = 四字段与某预设全等的派生判断，全不匹配即「自定义」。
 *
 * 字体槽留空 = 沿用默认栈（tokens.css --prose-font，衬线：霞鹜文楷→思源宋→宋体）；
 * 预设指名的字体未安装时经 PROSE_FONT_FALLBACK 基座优雅回落（如文楷未装回落
 * 思源宋/宋体），不空窗。字号/行距均在设置滑杆钳制域内（13-24 / 1.4-2.4）。
 */

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

export const PROSE_PRESETS: ProsePreset[] = [
  {
    id: 'default',
    label: '默认 · 雅黑',
    desc: '微软雅黑，屏显最稳（17px · 1.5）',
    values: { proseFontCn: 'Microsoft YaHei', proseFontEn: '', proseSize: 17, proseLh: 1.5 },
  },
  {
    id: 'noto-sans',
    label: '思源黑体 · 均衡',
    desc: '思源黑体（Noto Sans SC），字面方正现代 · 17px · 1.6',
    values: { proseFontCn: 'Noto Sans SC', proseFontEn: '', proseSize: 17, proseLh: 1.6 },
  },
  {
    id: 'songti',
    label: '宋体 · 经典',
    desc: '宋体（SimSun），传统书卷印刷感 · 17px · 1.6',
    values: { proseFontCn: 'SimSun', proseFontEn: '', proseSize: 17, proseLh: 1.6 },
  },
]

/** 当前排版态命中的预设 id；四字段无全等命中即 'custom'（派生值，不持久化） */
export function matchProsePreset(v: ProsePresetValues): string {
  const hit = PROSE_PRESETS.find(
    (p) =>
      p.values.proseFontCn === v.proseFontCn &&
      p.values.proseFontEn === v.proseFontEn &&
      p.values.proseSize === v.proseSize &&
      p.values.proseLh === v.proseLh,
  )
  return hit?.id ?? 'custom'
}
