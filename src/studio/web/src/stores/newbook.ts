/** 建书表单态（对照 v5 state nb* 域：段1 表单 + 段2 AI 填设定） */
import { defineStore } from 'pinia'
import type { BookKind, OnboardStep, OnboardStepKey } from '../types'
import { createBook, runOnboardStep, saveOnboardStep } from '../api/books'

interface NewbookState {
  /** 段 1 表单 / 段 2 onboard */
  phase: 'form' | 'onboard'
  name: string
  kind: BookKind
  genre: string
  /** 目标字数（输入框字符串，提交时 Number() 转） */
  target: string
  brief: string
  leads: string[]
  /** 段 2 AI 填设定步骤集（长篇 9 步 / 短篇 5 步） */
  steps: OnboardStep[]
  /** 段 1 提交态 */
  submitting: boolean
  error: string
  savedMsg: string
  /** 段 2：建书成功返回的书名（跳单书用） */
  createdName: string
}

/** 按 kind 构建段 2 步骤集（长篇 9 步 / 短篇 5 步） */
function buildSteps(kind: 'long' | 'short'): OnboardStep[] {
  if (kind === 'short') {
    return [
      { key: 'collection-pitch', label: '📋 集子定位', running: false, result: null },
      { key: 'first-outline', label: '📝 首篇细纲', running: false, result: null },
      { key: 'style-sample', label: '✍️ 文风样章', running: false, result: null },
      { key: 'style-rules', label: '📜 文风铁律', running: false, result: null },
      { key: 'style-quotes', label: '💎 金句库', running: false, result: null },
    ]
  }
  return [
    { key: 'synopsis', label: '📋 总纲', running: false, result: null },
    { key: 'characters', label: '👥 角色', running: false, result: null },
    { key: 'world', label: '🌍 世界观', running: false, result: null },
    { key: 'realm', label: '⚡ 境界体系', running: false, result: null },
    { key: 'volume', label: '📚 卷纲', running: false, result: null },
    { key: 'leads-seed', label: '🎯 账本种子', running: false, result: null },
    { key: 'style-sample', label: '✍️ 文风样章', running: false, result: null },
    { key: 'style-rules', label: '📜 文风铁律', running: false, result: null },
    { key: 'style-quotes', label: '💎 金句库', running: false, result: null },
  ]
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
    submitting: false,
    error: '',
    savedMsg: '',
    createdName: '',
  }),
  actions: {
    /** 重新建书：回到段 1 清空 */
    reset() {
      this.phase = 'form'
      this.name = ''
      this.kind = 'long'
      this.genre = ''
      this.target = ''
      this.brief = ''
      this.leads = []
      this.steps = []
      this.submitting = false
      this.error = ''
      this.savedMsg = ''
      this.createdName = ''
    },
    toggleLead(l: string) {
      const i = this.leads.indexOf(l)
      if (i >= 0) this.leads.splice(i, 1)
      else this.leads.push(l)
    },
    /** 段 1 提交：createBook → 进段 2（长篇且勾扩展类才传 leads，留空走题材推荐） */
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
        this.phase = 'onboard'
        this.steps = buildSteps(this.kind)
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      } finally {
        this.submitting = false
      }
    },
    /** 段 2 各步：POST /onboard-ai → spawnRole 产设定 → 落盘 + 展示 */
    async onboardRun(step: OnboardStepKey) {
      const s = this.steps.find((x) => x.key === step)
      if (!s || s.running || !this.createdName) return
      s.running = true
      s.result = null
      this.error = ''
      try {
        s.result = await runOnboardStep(this.createdName, step)
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      }
      s.running = false
    },
    /** 保存段 2 某步的编辑（作者预览后改内容再落盘，5.2 交互） */
    async onboardSave(s: OnboardStep) {
      if (!s.result || !this.createdName) return
      try {
        const d = await saveOnboardStep(this.createdName, s.key, s.result.content)
        s.result.words = d.words ?? s.result.content.length
        this.savedMsg = `✓ ${s.label} 已保存`
        this.error = ''
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      }
    },
  },
})
