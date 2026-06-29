/** 工作台态（对照 v5 state wb* 域：八阶段 + 流式输出 + 事件流） */
import { defineStore } from 'pinia'
import type { WbEvent, WbEventType } from '../types'

interface WorkbenchState {
  /** 当前阶段（outline/draft/check/review/finalize…） */
  stage: string
  /** 当前章/篇号 */
  chapter: number
  /** 写稿中 */
  running: boolean
  /** 正文流式输出 */
  textOut: string
  /** 机检报告 */
  check: string
  /** 审稿单 */
  review: string
  /** 裁决通过 */
  verdict: boolean
  /** 自动推进 */
  auto: boolean
  /** 事件流（驱动 EventStream + 日志） */
  events: WbEvent[]
}

export const useWorkbenchStore = defineStore('workbench', {
  state: (): WorkbenchState => ({
    stage: 'draft',
    chapter: 1,
    running: false,
    textOut: '',
    check: '',
    review: '',
    verdict: false,
    auto: true,
    events: [],
  }),
  actions: {
    /** 推事件（超 40 条滚动） */
    push(type: WbEventType, text: string) {
      this.events.push({
        t: new Date().toLocaleTimeString('zh-CN').slice(0, 8),
        type,
        text,
      })
      if (this.events.length > 40) this.events.shift()
    },
    clearEvents() {
      this.events = []
    },
    /** 清输出（切章/重写） */
    resetOutput() {
      this.textOut = ''
      this.check = ''
      this.review = ''
      this.verdict = false
    },
  },
})
