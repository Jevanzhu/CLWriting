/**
 * driver 抽象层类型(方案第 9 节)。
 *
 * driver 不编排,只「起会话 + 事件流」。编排权在 GUI / 各端点。
 * driver 唯一职责:cc / mock = SSE 基础设施(会话 + 事件总线);
 * 结构化产出走 gen.ts generateTool/generateText(不经 driver)。
 */

/** 一个 book 一个 driver session(切书:dispose 旧 + startSession 新) */
export interface Session {
  id: string
  cwd: string
  closed: boolean
}

export interface SessionOptions {}

/** driver 事件流(方案 9.2);role?: 区分主 agent vs 子角色产出 */
export type DriverEvent =
  | { type: 'init'; sessionId: string; agents: string[]; tools: string[] }
  | { type: 'text'; text: string; role?: string }
  /** 生成重试前清正文缓冲（B-1：流式重试防重复产出） */
  | { type: 'text_reset' }
  /** 非致命警告（如 max_tokens 截断）——UI toast 提示，不影响生成状态（B-3） */
  | { type: 'warning'; message: string }
  /** 非致命提示（AA-P3-1：如队列超容丢弃最旧消息——信息性告知，非警告） */
  | { type: 'notice'; message: string }
  | { type: 'tool_use'; tool: string; input: unknown; role?: string }
  | { type: 'role_spawn'; role: string; parentToolUseId: string }
  | { type: 'usage'; cost: number; tokens: number }
  | { type: 'error'; kind: string; message: string; recoverable: boolean }
  | { type: 'interrupted'; reason: string }
  | { type: 'review-progress'; lens: string; label: string; phase: 'start' | 'done' }
  // 全自动写章自愈闭环(self-heal.ts 经 emit 推主 session,/stream 转发前端)
  // P2-3：批量连写新增 phase 分支（chapter_start/chapter_done）+ chapter/done/total 进度字段
  // X-P1-2：lead_update——账本侧红补生成账本推进草稿（AI 调用，可能数秒~分钟）
  | { type: 'self_heal_phase'; phase: 'drafting' | 'checking' | 'rewriting' | 'lead_update' | 'chapter_start' | 'chapter_done'; attempt?: number; chapter?: number; done?: number; total?: number }
  /** 新一轮整章重写开始:前端清正文缓冲(整章重写是完整替换稿,不清会拼接多份) */
  | { type: 'self_heal_reset' }
  | { type: 'self_heal_progress'; attempt: number; maxAttempts: number; remaining: string[]; chapter?: number }
  /** P2-3：批量连写开跑（total=本次连写章数） */
  | { type: 'self_heal_batch'; total: number }
  /** P2-3：批量中途停（escalate/预算超限）——done=已完成章数,stoppedAt=停下的章号 */
  | { type: 'self_heal_batch_progress'; done: number; total: number; stoppedAt: number }
  | {
      type: 'self_heal_result'
      outcome: 'pass' | 'escalate' | 'aborted' | 'failed'
      reds?: string[]
      /** pass 时终稿黄项复查：仍命中的规则违规（message 列表，空 = 已收敛） */
      yellows?: string[]
      docId?: string
      path?: string
      error?: string
    }
  | { type: 'done'; cost: number; usage: number; reason: 'success' | 'cancelled' | 'error' }
  // 对话助手(chat.ts 经 emit 推主 session)
  | { type: 'chat_start' }
  | { type: 'chat_turn'; turn: number }
  | { type: 'chat_text'; text: string }
  | { type: 'chat_tool_pending'; callId: string; name: string; input: unknown }
  | { type: 'chat_tool'; callId: string; name: string; input: unknown }
  | { type: 'chat_tool_result'; callId: string; summary: string; ok: boolean }
  | { type: 'chat_reset' }
  | { type: 'chat_done'; inputTokens?: number; outputTokens?: number }
  | { type: 'chat_error'; error: string }

/** driver 接口(SSE 基础设施,窄化) */
export interface StudioDriver {
  /** 起会话(带项目上下文;不注入 SKILL.md) */
  startSession(cwd: string, opts?: SessionOptions): Promise<Session>
  /** 流式事件(持续;done 事件表示单次生成完,不断流) */
  stream(session: Session): AsyncIterable<DriverEvent>
  /** 结束会话 */
  dispose(session: Session): void
  /** 中断当前生成(推 interrupted;session 保留可再用)。可选,mock 可不实现 */
  interrupt?(session: Session): void
  /** 当前是否有存活的生成(SSE 新连接补发运行态快照用)。可选,mock 可不实现 */
  isRunning?(session: Session): boolean
  /** 登记生成任务的中断控制器——interrupt() 据此 abort 真实请求、isRunning() 据此判在途（P1-2）。可选,mock 可不实现 */
  registerCtrl?(session: Session, ctrl: AbortController): void
  /** 注销中断控制器（生成终态时调）——isRunning 归 false，SSE 快照不再假报「生成中」（X-P2-11）。可选 */
  unregisterCtrl?(session: Session, ctrl: AbortController): void
  /** 往 session 事件流推自定义事件(编排层回推进度,如 self-heal / review 逐角)。可选 */
  emit?(session: Session, ev: DriverEvent): void
}
