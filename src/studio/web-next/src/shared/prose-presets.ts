/**
 * 正文排版预设（F 线 2026-09-05 作者指令：不做默认翻转，做预设组合一键切换——
 * 「在字体那增加一个预设选项，几种我们预设好的组合选择」）。2026-09-05 晚
 * 作者拍板「只保留我觉得好看的预设」——按目测评结论精简为两套（默认 · 衬线 +
 * 无衬线 · 清爽）；旋即再要两套，样张页 A-D 四候选过目判「右边的好点」，按会话
 * 推荐落地 A+C：思源黑体 · 均衡（Noto Sans SC 400）+ 宋体 · 经典（SimSun）；
 * 文楷（D4 证伪糊）/ 思源宋（400 未亲验）/ 疏朗（未评测）/ 等线（备选未选）/
 * 西文编辑部（微调型未选）留设计稿记录可回。
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
    label: '默认 · 衬线',
    desc: '霞鹜文楷 → 思源宋 → 宋体，17px · 1.5',
    values: { proseFontCn: '', proseFontEn: '', proseSize: 17, proseLh: 1.5 },
  },
  {
    id: 'sans',
    label: '无衬线 · 清爽',
    desc: '微软雅黑（mac 落苹方），17px · 1.5',
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
