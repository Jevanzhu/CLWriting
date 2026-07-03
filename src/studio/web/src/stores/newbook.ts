/**
 * 建书表单态：纯表单（书名/题材/类型/字数/简介/账本）→ createBook → 设 createdName。
 * page（BookNew）watch createdName 跳工作区；AI 设定生成在工作区（useOnboardStore）。
 */
import { defineStore } from 'pinia'
import type { BookKind } from '../types'
import { createBook } from '../api/books'

interface NewbookState {
  name: string
  kind: BookKind
  genre: string
  /** 目标字数（输入框字符串，提交时 Number() 转） */
  target: string
  brief: string
  leads: string[]
  submitting: boolean
  error: string
  /** 建书成功返回的书名（page watch 此字段跳工作区） */
  createdName: string
}

export const useNewbookStore = defineStore('newbook', {
  state: (): NewbookState => ({
    name: '',
    kind: 'long',
    genre: '',
    target: '',
    brief: '',
    leads: [],
    submitting: false,
    error: '',
    createdName: '',
  }),
  actions: {
    /** 重新建书：清空表单 */
    reset() {
      this.name = ''
      this.kind = 'long'
      this.genre = ''
      this.target = ''
      this.brief = ''
      this.leads = []
      this.submitting = false
      this.error = ''
      this.createdName = ''
    },
    toggleLead(l: string) {
      const i = this.leads.indexOf(l)
      if (i >= 0) this.leads.splice(i, 1)
      else this.leads.push(l)
    },
    /** 提交：createBook → 设 createdName（page watch 跳工作区） */
    async submit() {
      this.submitting = true
      this.error = ''
      try {
        const body = {
          name: this.name.trim(),
          genre: this.genre.trim(),
          kind: this.kind,
          host: 'cc',
        }
        const request = { ...body } as Parameters<typeof createBook>[0]
        if (this.kind === 'long' && this.leads.length > 0) request.leads = this.leads
        const tw = Number(this.target)
        if (Number.isFinite(tw) && tw > 0) request.targetWords = tw
        if (this.brief.trim()) request.brief = this.brief.trim()
        const data = await createBook(request)
        this.createdName = data.name ?? this.name.trim()
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.submitting = false
      }
    },
  },
})
