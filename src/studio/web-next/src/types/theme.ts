/** 主题：Obsidian 式亮/暗双主题（M10 重写，取代旧 8 档色温）。
 * CSS 响应 [data-theme] 属性，tokens.css 两档覆盖全套语义变量。*/
export type ThemeId = 'light' | 'dark'

export interface ThemeDef {
  id: ThemeId
  name: string
}

export const THEMES: ThemeDef[] = [
  { id: 'light', name: '亮色' },
  { id: 'dark', name: '暗色' },
]
