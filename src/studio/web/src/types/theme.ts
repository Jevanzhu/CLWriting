/** 主题：单 mono（黑白灰）。原 7 套 2026-06-29 废弃，CSS 不再响应 [data-theme]。变量见 styles/tokens.css */

export type ThemeId = 'mono'

export interface ThemeDef {
  id: ThemeId
  name: string
  desc: string
  accent: string
}

export const THEMES: ThemeDef[] = [{ id: 'mono', name: 'mono', desc: '黑白灰', accent: '#1a1a1a' }]
