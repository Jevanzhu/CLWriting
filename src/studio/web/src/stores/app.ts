/** 应用全局态（view/mode 由路由决定，不入 store） */
import { defineStore } from 'pinia'

interface AppState {
  /** 专注模式（⤢） */
  focus: boolean
}

export const useAppStore = defineStore('app', {
  state: (): AppState => ({ focus: false }),
  actions: {
    toggleFocus() {
      this.focus = !this.focus
    },
  },
})
