/** 主题：7 档白天色温（明亮/暖/柔/绿/冷/麻布/烟雨/雾蓝），偏阅读写作。
 * 2026-07-02 整合原"阅读配色"；同日加墨绿/冷灰，后删夜读、补麻布/烟雨/雾蓝（白天沉静向）。
 * CSS 响应 [data-theme] 属性，tokens.css 各块覆盖全套色 token（含编辑器 reader 变量）。 */

export type ThemeId = 'mono' | 'paper' | 'soft' | 'moss' | 'cool' | 'linen' | 'mist' | 'haze'

export interface ThemeDef {
  id: ThemeId
  name: string
  desc: string
  accent: string
}

export const THEMES: ThemeDef[] = [
  { id: 'mono', name: '标准', desc: '黑白墨色 · 明亮', accent: '#1a1a1a' },
  { id: 'paper', name: '暖纸', desc: '米白纸 + 墨褐 · 阅读舒适', accent: '#3d352a' },
  { id: 'soft', name: '柔光', desc: '降对比深灰 · 柔和', accent: '#3a3a3a' },
  { id: 'moss', name: '墨绿', desc: '豆沙绿 · 长时间护眼', accent: '#2f3a2e' },
  { id: 'cool', name: '冷灰', desc: '冷感低饱和 · 专注', accent: '#2f3338' },
  { id: 'linen', name: '麻布', desc: '暖沉灰 · 麻布质感', accent: '#3a322a' },
  { id: 'mist', name: '烟雨', desc: '冷青灰 · 水墨沉静', accent: '#2f363a' },
  { id: 'haze', name: '雾蓝', desc: '沉静蓝调 · 专注', accent: '#2e3645' },
]
