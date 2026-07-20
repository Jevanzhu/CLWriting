/**
 * 工作台态（八阶段 + 流式输出；事件流走 useWorkbenchLog 共享）。
 * SSE EventSource 由 page 持有生命周期，onmessage → handleEvent 推 store。
 * 流程 action 用 this.name（page 经 enter(name) 设置）。
 */
import { defineStore } from 'pinia'
import { useWorkbenchLog } from '../composables/useWorkbenchLog'
import {
  approveReview,
  generateOutline,
  getConfig,
  getDraftPrompt,
  getState,
  interruptBook,
  runCli,
  runReview,
  saveDraft as apiSaveDraft,
  spawnRole,
} from '../api/books'

/** driver 事件（松类型，按 type 分支取字段） */
interface DriverEvent {
  type: string
  [k: string]: unknown
}

interface WorkbenchState {
  /** 当前书名（page 经 enter 设置，actions 共用） */
  name: string
  /** 当前阶段高亮（outline/draft/check/review/finalize…） */
  activeStage: string
  /** 当前章/篇号 */
  chapter: number
  /** 写稿中 */
  running: boolean
  outlineRunning: boolean
  /** 写稿模式（done 后触发 saveDraft） */
  draftMode: boolean
  cliRunning: boolean
  reviewRunning: boolean
  /** 正文流式输出 */
  textOut: string
  /** 草稿落盘结果 */
  saved: { path: string; words: number } | null
  outlineSaved: { path: string; words: number } | null
  /** 机检报告（check stdout） */
  checkReport: string
  /** 审稿单（review report 全文） */
  reviewReport: string
  /** rebook 对账报告（态 3 未入账手改补登） */
  rebookReport: string
  verdictApproved: boolean
  /** enter 自动定位：状态卡（当前态 + 人话） */
  stateInfo: { state: number; stateName: string; humanMsg: string; action: string } | null
  /** 自动推进（确定性步→确定性步自动，AI/人工步前停） */
  autoAdvance: boolean
  /** draft 中断（保留已生成，可弃稿/重写） */
  interrupted: boolean
  kind: 'long' | 'short'
  /** 写作模式（W2B §3.1）：决定写章 tab 走手写还是 AI 八阶段 */
  workflow: 'free' | 'assist' | 'strict'
}

/** 共享事件日志（模块级单例，右栏 EventStream 联动） */
const wbLog = useWorkbenchLog()

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

export const useWorkbenchStore = defineStore('workbench', {
  state: (): WorkbenchState => ({
    name: '',
    activeStage: 'draft',
    chapter: 1,
    running: false,
    outlineRunning: false,
    draftMode: false,
    cliRunning: false,
    reviewRunning: false,
    textOut: '',
    saved: null,
    outlineSaved: null,
    checkReport: '',
    reviewReport: '',
    rebookReport: '',
    verdictApproved: false,
    stateInfo: null,
    autoAdvance: true,
    interrupted: false,
    kind: 'long',
    workflow: 'strict',
  }),
  actions: {
    /** SSE 事件处理：按 type 更新态 + 推 log */
    handleEvent(ev: DriverEvent) {
      const log = wbLog.log
      const t = ts()
      switch (ev.type) {
        case 'init':
          log.value.push({ t, type: 'init', text: `会话就绪 · 角色 ${((ev.agents as string[]) ?? []).join('/')}` })
          break
        case 'text':
          this.textOut += String(ev.text ?? '')
          break
        case 'tool_use':
          log.value.push({ t, type: 'tool', text: `🔧 ${ev.tool}` })
          break
        case 'usage':
          log.value.push({ t, type: 'usage', text: `成本 $${ev.cost} · ${ev.tokens} tokens` })
          break
        case 'review-progress':
          // 三审逐角进度回流
          log.value.push({
            t,
            type: 'spawn',
            text: `${ev.phase === 'start' ? '🔍' : '✓'} ${String(ev.label ?? '')}审${ev.phase === 'start' ? '中…' : '完'}`,
          })
          break
        case 'interrupted':
          // draft 中断：保留已生成，等作者弃稿/重写
          this.running = false
          this.draftMode = false
          this.interrupted = true
          log.value.push({ t, type: 'error', text: `⏹ 已中断(${String(ev.reason ?? '')})——正文已保留,可弃稿或改指令重写` })
          break
        case 'done':
          this.running = false
          log.value.push({ t, type: 'done', text: `完成(${ev.reason})` })
          if (this.draftMode) void this.saveDraft()
          break
        case 'error':
          this.running = false
          this.draftMode = false
          log.value.push({ t, type: 'error', text: `错误:${ev.message}` })
          break
      }
    },
    /** enter：设 name + loadState（状态卡 + 自动填章号） */
    async enter(name: string) {
      this.name = name
      await this.loadState()
    },
    /** kind（getConfig） */
    async loadKind() {
      try {
        const config = await getConfig(this.name)
        this.kind = (config.kind ?? 'long') === 'short' ? 'short' : 'long'
        this.workflow = config.workflow ?? 'strict'
      } catch {
        /* ignore */
      }
    },
    /** /state → 状态卡 + 自动填章号（失败不阻塞） */
    async loadState() {
      if (!this.name) return
      try {
        const d = await getState(this.name)
        this.stateInfo = {
          state: d.state ?? 0,
          stateName: d.stateName ?? '',
          humanMsg: d.humanMsg ?? '',
          action: d.action ?? '',
        }
        if (typeof d.nextChapter === 'number' && d.nextChapter > 0) this.chapter = d.nextChapter
      } catch {
        /* 状态卡可选,失败不阻塞 */
      }
    },
    /** CLI 确定性步：confirm/prepare/check/finalize。返回是否成功（供自动推进判断） */
    async runCliStep(step: 'confirm' | 'prepare' | 'check' | 'finalize' | 'hand'): Promise<boolean> {
      const log = wbLog.log
      if (this.cliRunning || this.running || this.outlineRunning || this.reviewRunning || !this.name) return false
      this.cliRunning = true
      this.activeStage = step
      this.interrupted = false
      log.value.push({ t: ts(), type: 'spawn', text: `${step} 第 ${this.chapter} ${this.kind === 'short' ? '篇' : '章'}…` })
      let stepOk = false
      try {
        const d = await runCli(this.name, { step, chapter: this.chapter })
        const out = String(d.stdout ?? '').trim()
        const err = String(d.stderr || d.stdout || '').trim()
        if (d.ok) {
          stepOk = true
          if (step === 'check') {
            this.checkReport = out
            log.value.push({ t: ts(), type: 'saved', text: `机检 ✓(见机检报告)` })
          } else if (step === 'finalize') {
            log.value.push({ t: ts(), type: 'saved', text: `定稿 ✓ ${out.slice(0, 80)}` })
          } else if (step === 'hand') {
            log.value.push({ t: ts(), type: 'saved', text: `手写草稿已建 ✓ ${out.slice(0, 60)}（左侧文件树编辑正文）` })
          } else {
            log.value.push({ t: ts(), type: 'saved', text: `${step} ✓ ${out.slice(0, 80)}` })
          }
        } else {
          if (step === 'check') this.checkReport = err
          log.value.push({ t: ts(), type: 'error', text: `${step} 失败:${err.slice(0, 120)}` })
        }
      } catch (e) {
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
      this.cliRunning = false
      // 自动推进：confirm done → prepare（确定性→确定性）；prepare/check 后是 AI 步停；finalize 末步停
      if (stepOk && this.autoAdvance && step === 'confirm') {
        log.value.push({ t: ts(), type: 'spawn', text: `→ 自动备料` })
        void this.runCliStep('prepare')
      }
      return stepOk
    },
    /** outline 生成：POST /outline（后端组 prompt + spawnRole('outline') + 落盘细纲） */
    async outlineGen() {
      const log = wbLog.log
      if (this.outlineRunning || this.running || !this.name) return
      this.outlineRunning = true
      this.outlineSaved = null
      this.activeStage = 'outline'
      log.value.push({ t: ts(), type: 'spawn', text: `生成第 ${this.chapter} ${this.kind === 'short' ? '篇篇纲' : '章细纲'}…` })
      try {
        const d = await generateOutline(this.name, this.chapter)
        this.outlineSaved = d
        log.value.push({ t: ts(), type: 'saved', text: `${this.kind === 'short' ? '篇纲' : '细纲'}已生成 ${d.path}(${d.words} 字)` })
      } catch (e) {
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
      this.outlineRunning = false
    },
    /** draft 写稿：组 prompt → spawnRole(writer) → 事件流收 text → done 后 saveDraft 落盘 */
    async draftWrite() {
      const log = wbLog.log
      if (this.running || !this.name) return
      this.draftMode = true
      this.interrupted = false
      this.saved = null
      this.textOut = ''
      this.running = true
      this.activeStage = 'draft'
      let prompt = ''
      try {
        prompt = await getDraftPrompt(this.name, this.chapter)
      } catch (e) {
        this.running = false
        this.draftMode = false
        log.value.push({ t: ts(), type: 'error', text: `拉 draft-prompt 失败:${e instanceof Error ? e.message : String(e)}` })
        return
      }
      if (!prompt.includes('本章细纲')) {
        this.running = false
        this.draftMode = false
        log.value.push({ t: ts(), type: 'error', text: 'draft 缺细纲——请先「生成细纲→确认→备料」再写稿' })
        return
      }
      log.value.push({ t: ts(), type: 'spawn', text: `spawnRole(writer)·第 ${this.chapter} ${this.kind === 'short' ? '篇(含篇纲)' : '章(含细纲+备料)'}` })
      try {
        await spawnRole(this.name, { role: 'writer', prompt, mode: 'spawnRole' })
      } catch (e) {
        this.running = false
        this.draftMode = false
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
    },
    /** 中断当前写稿：POST /interrupt → driver kill 子进程 + 推 interrupted */
    async interruptWrite() {
      if (!this.name) return
      try {
        await interruptBook(this.name)
      } catch {
        /* interrupted 事件会经 SSE 到达,前端自行收尾 */
      }
    },
    /** 弃稿：清空已生成正文 */
    discardDraft() {
      const log = wbLog.log
      this.textOut = ''
      this.interrupted = false
      this.saved = null
      log.value.push({ t: ts(), type: 'error', text: '已弃稿(清空正文)' })
    },
    /** 三审：POST /review（run→spawnRole×3→collect）→ 审稿单 */
    async reviewRun() {
      const log = wbLog.log
      if (this.reviewRunning || this.running || this.cliRunning || this.outlineRunning || !this.name) return
      this.reviewRunning = true
      this.reviewReport = ''
      this.verdictApproved = false
      this.activeStage = 'review'
      log.value.push({ t: ts(), type: 'spawn', text: `三审第 ${this.chapter} ${this.kind === 'short' ? '篇' : '章'}(run→镜头审→collect)…` })
      try {
        const d = await runReview(this.name, this.chapter)
        this.reviewReport = d.report ?? ''
        log.value.push({ t: ts(), type: 'saved', text: `三审 ✓ 视角:${(d.lenses ?? []).join('/')}(见审稿单)` })
      } catch (e) {
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
      this.reviewRunning = false
    },
    /** 裁决通过：POST /review-verdict {approved:true} → finalize 可放行 */
    async verdictApprove() {
      const log = wbLog.log
      if (!this.name || !this.reviewReport) return
      try {
        await approveReview(this.name)
        this.verdictApproved = true
        log.value.push({ t: ts(), type: 'saved', text: `裁决:通过(可定稿)` })
        // 自动推进：裁决通过 → 定稿（人工 done → 确定性步）
        if (this.autoAdvance) {
          log.value.push({ t: ts(), type: 'spawn', text: `→ 自动定稿` })
          void this.runCliStep('finalize')
        }
      } catch (e) {
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
    },
    /** 态 3 rebook：查看对账（yes=false）/ 确认补登（yes=true）；补登后重载态 */
    async rebookRun(yes: boolean): Promise<void> {
      const log = wbLog.log
      if (this.cliRunning || !this.name) return
      this.cliRunning = true
      this.activeStage = 'rebook'
      log.value.push({ t: ts(), type: 'spawn', text: yes ? 'rebook 补登中…' : 'rebook 对账报告中…' })
      try {
        const d = await runCli(this.name, { step: 'rebook', yes })
        const out = String(d.stdout ?? '').trim()
        if (d.ok) {
          this.rebookReport = out
          log.value.push({ t: ts(), type: 'saved', text: yes ? `补登 ✓ ${out.slice(0, 60)}` : '对账报告 ✓（见下）' })
          if (yes) await this.loadState()
        } else {
          log.value.push({ t: ts(), type: 'error', text: `rebook 失败:${out.slice(0, 120)}` })
        }
      } catch (e) {
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
      this.cliRunning = false
    },
    /** done 后落盘：driver text → 工作区/草稿-N.md */
    async saveDraft() {
      const log = wbLog.log
      const content = this.textOut.trim()
      if (!content) {
        this.draftMode = false
        return
      }
      try {
        const d = await apiSaveDraft(this.name, { chapter: this.chapter, content })
        this.saved = d
        log.value.push({ t: ts(), type: 'saved', text: `已保存 ${d.path}(${d.words} 字)` })
        // 自动推进：draft 落盘 → 机检（AI done → 确定性步）
        if (this.autoAdvance) {
          log.value.push({ t: ts(), type: 'spawn', text: `→ 自动机检` })
          void this.runCliStep('check')
        }
      } catch (e) {
        log.value.push({ t: ts(), type: 'error', text: e instanceof Error ? e.message : String(e) })
      }
      this.draftMode = false
    },
  },
})
