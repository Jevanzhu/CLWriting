import { storeToRefs } from 'pinia'
import { useAppStore } from '../stores/app'
import { THEMES, type ThemeId, type ThemeDef } from '../types/theme'

// 主题系统：7 套配色（对照 v5 THEMES）。状态走 useAppStore（单源），
// 本 composable 是 thin wrapper，保持 useTheme() API 不变（AppShell / SettingsModal 等无感迁移）。

export type { ThemeId, ThemeDef }
export { THEMES }

export function useTheme() {
  const app = useAppStore()
  const { theme } = storeToRefs(app)
  return {
    theme,
    themes: THEMES,
    setTheme: (id: ThemeId): void => {
      app.setTheme(id)
    },
    cycleTheme: (): void => {
      app.cycleTheme()
    },
    themeName: (): string => app.themeName,
  }
}
