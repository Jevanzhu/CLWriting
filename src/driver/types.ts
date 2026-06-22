/**
 * driver 抽象层类型(方案第 9 节)。
 *
 * driver 不编排,只「起会话 + 单步生成 + 事件流」。编排权在 GUI。
 * 架构红线:driver 唯一职责 = 驱动 CC(批2 spawn claude)/ mock(批1);
 * GUI 后端不直连大模型(见 memory gui-不直连大模型)。
 */

/** 一个 book 一个 driver session(切书:dispose 旧 + startSession 新) */
export interface Session {
  id: string
  cwd: string
  closed: boolean
}

export interface SessionOptions {
  /** 角色系统提示加载目录(.claude/agents/*);省略用书仓库默认 */
  agentsDir?: string
}

export interface ApprovalResponse {
  id: string
  accept: boolean
  /** 选择题选项 */
  choice?: string
}

/** driver 事件流(方案 9.2);role?: 区分主 agent vs 子角色产出 */
export type DriverEvent =
  | { type: 'init'; sessionId: string; agents: string[]; tools: string[] }
  | { type: 'text'; text: string; role?: string }
  | { type: 'tool_use'; tool: string; input: unknown; role?: string }
  | { type: 'tool_result'; result: unknown; role?: string }
  | { type: 'role_spawn'; role: string; parentToolUseId: string }
  | { type: 'approval_request'; id: string; choices: string[]; detail: string }
  | { type: 'usage'; cost: number; tokens: number }
  | { type: 'error'; kind: string; message: string; recoverable: boolean }
  | { type: 'interrupted'; reason: string }
  | { type: 'done'; cost: number; usage: number; reason: 'success' | 'cancelled' | 'error' }

/** driver 接口(B 编排:单步生成器,窄化) */
export interface StudioDriver {
  /** 起会话(带项目上下文;不注入 SKILL.md) */
  startSession(cwd: string, opts?: SessionOptions): Promise<Session>
  /** 主操作:以角色系统提示起单步生成(B 默认,干净上下文) */
  spawnRole(session: Session, role: string, prompt: string): void
  /** 辅:软触发主 agent 编排(仅 outline 等多源合成,--resume 续主 session) */
  send(session: Session, prompt: string): void
  /** 流式事件(持续;done 事件表示单次生成完,不断流) */
  stream(session: Session): AsyncIterable<DriverEvent>
  /** 审批 / 选择回灌 */
  respondApproval(session: Session, approval: ApprovalResponse): void
  /** 续会话 */
  resume(sessionId: string): Promise<Session>
  /** 结束会话 */
  dispose(session: Session): void
}
