// 主题：单 mono（原 7 套 2026-06-29 废弃）。thin wrapper 保留 useTheme() API 兼容（AppShell themeName）。
import { THEMES, type ThemeId, type ThemeDef } from '../types/theme'

export type { ThemeId, ThemeDef }
export { THEMES }

export function useTheme() {
  return {
    theme: 'mono' as ThemeId,
    themes: THEMES,
    themeName: (): string => 'mono',
  }
}
