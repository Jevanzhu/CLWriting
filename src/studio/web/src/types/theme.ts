/** 主题（对照 v5 THEMES 7 套）。CSS 变量见 styles/tokens.css */

export type ThemeId = 'ink' | 'night' | 'plain' | 'slate' | 'cloud' | 'space' | 'moran'

export interface ThemeDef {
  id: ThemeId
  name: string
  desc: string
  /** 主色（swatch 预览用） */
  accent: string
}

/** 7 套主题（ink/night/plain/slate 已落地 token；cloud/space/moran 待补） */
export const THEMES: ThemeDef[] = [
  { id: 'ink', name: '墨韵', desc: '宣纸暖 · 中式中浅', accent: '#1f5f5b' },
  { id: 'night', name: '墨夜', desc: '宣纸暖 · 深色', accent: '#5fa39d' },
  { id: 'plain', name: '素简', desc: '米白冷 · 企业风', accent: '#16a34a' },
  { id: 'slate', name: '青砚', desc: '灰青冷 · 专业', accent: '#2f6b6b' },
  { id: 'cloud', name: '云白', desc: '极简浅 · Linear 风', accent: '#2563eb' },
  { id: 'space', name: '深空', desc: '科技深 · GitHub 风', accent: '#58a6ff' },
  { id: 'moran', name: '莫兰迪', desc: '低饱和 · 雾感现代', accent: '#7a8ca6' },
]
