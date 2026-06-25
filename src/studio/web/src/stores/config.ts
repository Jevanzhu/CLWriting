/** 排版配置（对照 v5 state cfg* 域：字体/字号/行高/段距，实时应用） */
import { defineStore } from 'pinia'

interface ConfigState {
  font: string
  size: number
  lh: number
  gap: number
}

export const useConfigStore = defineStore('config', {
  state: (): ConfigState => ({
    font: "STKaiti, '楷体', serif",
    size: 16.5,
    lh: 2.0,
    gap: 16,
  }),
  actions: {
    /** 应用排版到 CSS 变量（prose 消费） */
    apply() {
      const el = document.documentElement
      el.style.setProperty('--prose-font', this.font)
      el.style.setProperty('--prose-size', `${this.size}px`)
      el.style.setProperty('--prose-lh', String(this.lh))
      el.style.setProperty('--prose-gap', `${this.gap}px`)
    },
  },
})
