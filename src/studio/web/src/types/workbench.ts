/** 工作台事件流（对照 v5 EVENTS；对接 SSE /api/books/:name/stream） */

export type WbEventType = 'init' | 'spawn' | 'text' | 'saved' | 'done' | 'error'

/** 工作台事件（驱动 EventStream + Workbench 日志） */
export interface WbEvent {
  t: string
  type: WbEventType
  text: string
}
