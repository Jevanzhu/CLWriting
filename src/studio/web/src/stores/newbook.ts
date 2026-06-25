/** 建书表单态（对照 v5 state nb* 域：段1 表单 + 段2 AI 填设定） */
import { defineStore } from 'pinia'
import type { BookKind, OnboardStep } from '../types'

interface NewbookState {
  /** 段 1 表单 / 段 2 onboard */
  phase: 'form' | 'onboard'
  name: string
  kind: BookKind
  genre: string
  target: string
  brief: string
  leads: string[]
  steps: OnboardStep[]
}

export const useNewbookStore = defineStore('newbook', {
  state: (): NewbookState => ({
    phase: 'form',
    name: '',
    kind: 'long',
    genre: '',
    target: '',
    brief: '',
    leads: [],
    steps: [],
  }),
  actions: {
    /** 重新建书：回到段 1 清空 */
    reset() {
      this.phase = 'form'
      this.name = ''
      this.genre = ''
      this.target = ''
      this.brief = ''
      this.leads = []
      this.steps = []
    },
    toggleLead(l: string) {
      const i = this.leads.indexOf(l)
      if (i >= 0) this.leads.splice(i, 1)
      else this.leads.push(l)
    },
  },
})
