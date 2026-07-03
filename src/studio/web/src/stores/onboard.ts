/**
 * 开书设定生成态（工作区「设定」模式）：分步式 + 对话式 + 整理到步。
 *
 * - 分步：onboardRun/onboardSave（/onboard-ai + /onboard-save）
 * - 对话：sendChat（spawnRole send 多轮）→ SSE handleChatEvent 累加 messages
 * - 整理到步：convergeToStep（runOnboardStep 传 discussionContext=对话历史 → 填该步 result → 作者预览改 → onboardSave）
 *
 * page（Workbench）enter(name, kind) 初始化；SSE EventSource 由 page 持有，onmessage → handleChatEvent。
 */
import { defineStore } from 'pinia'
import type { BookKind, OnboardStep, OnboardStepKey, ChatMessage } from '../types'
import { runOnboardStep, saveOnboardStep, spawnRole, interruptBook } from '../api/books'
import { useWorkbenchLog } from '../composables/useWorkbenchLog'

/** driver 事件（松类型，按 type 分支取字段） */
interface DriverEvent {
  type: string
  [k: string]: unknown
}

interface OnboardState {
  /** 当前书名（page enter 设） */
  name: string
  kind: BookKind
  /** 分步设定列表（长篇 9 步 / 短篇 5 步） */
  steps: OnboardStep[]
  /** 对话消息（设定讨论） */
  messages: ChatMessage[]
  /** 对话 AI 回复中 */
  chatRunning: boolean
  /** 整理到步中 */
  converging: boolean
  error: string
  savedMsg: string
}

/** 按 kind 构建分步集（长篇 9 步 / 短篇 5 步） */
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

function now(): string {
  return new Date().toLocaleTimeString('zh-CN')
}

/** 共享事件日志（模块级单例，右栏 EventStream 联动） */
const wbLog = useWorkbenchLog()

/** 组对话 prompt：设定顾问，聚焦讨论设定（不读/写文件） */
function buildChatPrompt(name: string, kind: BookKind, messages: ChatMessage[]): string {
  const ctx = `书名:《${name}》  篇幅:${kind === 'short' ? '短篇集' : '长篇'}`
  const recent = messages
    .slice(-8)
    .map((m) => `${m.role === 'user' ? '作者' : 'AI'}：${m.text}`)
    .join('\n')
  return [
    '## 角色',
    '你是开书设定顾问，帮作者讨论并完善这本小说的初始设定（世界观/角色/主线/文风等）。',
    '',
    '## 当前书',
    ctx,
    '',
    '## 对话历史（近 8 轮）',
    recent || '(刚开始)',
    '',
    '## 要求',
    '- 据作者发言推进讨论：缺啥问啥、有想法给建议、设定矛盾就指出',
    '- 不臆造作者没认可的具体设定，给选项让作者拍板',
    '- 每轮回复聚焦、可操作，别一次铺太多',
    '- 不读文件、不写文件（讨论结果由作者「整理到步」落盘）',
  ].join('\n')
}

/** 把对话历史压成紧凑 context（给整理到步用） */
function messagesToContext(messages: ChatMessage[]): string {
  return messages.map((m) => `${m.role === 'user' ? '作者' : 'AI'}：${m.text}`).join('\n')
}

export const useOnboardStore = defineStore('onboard', {
  state: (): OnboardState => ({
    name: '',
    kind: 'long',
    steps: [],
    messages: [],
    chatRunning: false,
    converging: false,
    error: '',
    savedMsg: '',
  }),
  actions: {
    /** page 进工作区设定模式时调：设 name/kind + 构建 steps */
    enter(name: string, kind: BookKind) {
      this.name = name
      this.kind = kind
      this.steps = buildSteps(kind)
      this.messages = []
      this.chatRunning = false
      this.converging = false
      this.error = ''
      this.savedMsg = ''
    },
    /** 分步生成：POST /onboard-ai → spawnRole 产设定 → 落盘 + 展示 */
    async onboardRun(step: OnboardStepKey) {
      const s = this.steps.find((x) => x.key === step)
      if (!s || s.running || !this.name) return
      s.running = true
      s.result = null
      this.error = ''
      try {
        s.result = await runOnboardStep(this.name, step)
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      }
      s.running = false
    },
    /** 保存分步编辑（作者预览改后落盘） */
    async onboardSave(s: OnboardStep) {
      if (!s.result || !this.name) return
      try {
        const d = await saveOnboardStep(this.name, s.key, s.result.content)
        s.result.words = d.words ?? s.result.content.length
        this.savedMsg = `✓ ${s.label} 已保存`
        this.error = ''
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      }
    },
    /** 对话：发一句 → spawnRole(send) → SSE text 累加末条 AI 消息 */
    async sendChat(message: string) {
      const msg = message.trim()
      if (!msg || this.chatRunning || !this.name) return
      this.messages.push({ role: 'user', text: msg, ts: now() })
      this.chatRunning = true
      this.error = ''
      const prompt = buildChatPrompt(this.name, this.kind, this.messages)
      try {
        await spawnRole(this.name, { role: 'main', prompt, mode: 'send' })
      } catch (e) {
        this.chatRunning = false
        this.error = e instanceof Error ? e.message : String(e)
      }
    },
    /** SSE 事件 → 累加末条 AI 消息 / done 收尾 */
    handleChatEvent(ev: DriverEvent) {
      const log = wbLog.log
      const t = now()
      switch (ev.type) {
        case 'text': {
          if (!this.chatRunning) break
          const chunk = String((ev as { text?: string }).text ?? '')
          if (!chunk) break
          const last = this.messages[this.messages.length - 1]
          if (last && last.role === 'assistant') {
            last.text += chunk
          } else {
            this.messages.push({ role: 'assistant', text: chunk, ts: t })
          }
          break
        }
        case 'tool_use':
          log.value.push({ t, type: 'tool', text: `🔧 ${String((ev as { tool?: string }).tool ?? '')}` })
          break
        case 'usage':
          log.value.push({
            t,
            type: 'usage',
            text: `成本 $${(ev as { cost?: number }).cost ?? 0} · ${(ev as { tokens?: number }).tokens ?? 0} tokens`,
          })
          break
        case 'done':
          this.chatRunning = false
          log.value.push({ t, type: 'done', text: `完成(${String((ev as { reason?: string }).reason ?? '')})` })
          break
        case 'error':
          this.chatRunning = false
          this.error = `对话错误:${String((ev as { message?: string }).message ?? '')}`
          log.value.push({ t, type: 'error', text: `错误:${String((ev as { message?: string }).message ?? '')}` })
          break
        case 'interrupted':
          this.chatRunning = false
          log.value.push({ t, type: 'error', text: '⏹ 已中断' })
          break
      }
    },
    /** 中断当前 AI 回复 */
    async interruptChat() {
      if (!this.name) return
      try {
        await interruptBook(this.name)
      } catch {
        /* interrupted 事件经 SSE 到达 */
      }
    },
    /** 据对话历史整理到指定步（onboard-ai + discussionContext → 填该步 result，作者预览改后保存） */
    async convergeToStep(step: OnboardStepKey) {
      const s = this.steps.find((x) => x.key === step)
      if (!s || this.converging || !this.name || !this.messages.length) return
      this.converging = true
      s.running = true
      s.result = null
      this.error = ''
      try {
        s.result = await runOnboardStep(this.name, step, messagesToContext(this.messages))
        this.savedMsg = `✓ 已据讨论整理「${s.label}」，请预览后保存`
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e)
      }
      s.running = false
      this.converging = false
    },
  },
})
