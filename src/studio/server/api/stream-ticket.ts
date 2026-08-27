/**
 * SSE 一次性短时效 ticket 端点（T2 批低危项：SSE token 走 URL query 的信道收敛）。
 *
 * POST /api/stream-ticket → { ticket, expiresInMs }
 *
 * EventSource 无法自定义请求头，SSE 凭据此前只能拼 `?token=` 进 URL——token 会进
 * 进程列表/代理日志。本端点让持有 token 的客户端（POST 走写闸：Origin + 常量时间
 * token 头校验）换取一次性短时效 ticket，SSE 连接改带 `?ticket=`；token 不再出 URL。
 * ticket 一次性（连接校验即消费）+ 60s 过期，仅作「拿到 boot 的客户端」凭据中转，
 * 不承诺防本机进程（ee-P2-12 同源口径）。`?token=` 旧通道保留（e2e/兼容期，注释
 * 见 stream.ts 校验处），新前端零配置自动切换。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { defineRoute } from './schema.js'
import { reply } from '../http.js'

const TICKET_TTL_MS = 60_000
// Z-10（第五十八轮·登记）：模块级单例——同进程二次 startServer 不清空（旧实例的
// 未过期 ticket 在新实例仍可消费）。生产形态（Electron child 单进程单 server）不触发；
// server-main/e2e 同进程多实例形态按单实例假设使用。
const tickets = new Map<string, number>()

function pruneExpired(now: number): void {
  for (const [t, exp] of tickets) {
    if (exp <= now) tickets.delete(t)
  }
}

/** 签发一次性 ticket（POST /api/stream-ticket 已过写闸 = 调用方持有 token） */
function issueTicket(): { ticket: string; expiresInMs: number } {
  const now = Date.now()
  pruneExpired(now)
  const ticket = randomUUID()
  tickets.set(ticket, now + TICKET_TTL_MS)
  return { ticket, expiresInMs: TICKET_TTL_MS }
}

/** 消费 ticket：存在且未过期即删（一次性）并放行；不存在/过期/已用过返回 false */
export function consumeStreamTicket(ticket: string | undefined): boolean {
  if (!ticket) return false
  const exp = tickets.get(ticket)
  if (exp === undefined || exp <= Date.now()) {
    tickets.delete(ticket)
    return false
  }
  tickets.delete(ticket)
  return true
}

/**
 * R65-43（总六十五轮）：ticket 预检（不消费）——SSE 鉴权闸需在书域校验（429/404）
 * 之前判定凭据有效性（R64-27 防书名探测语义），但一次性消费须等全部校验通过后
 * （429/404 不烧票）。存在且未过期即 true；过期顺手清理（与 consume 同口径）。
 */
export function peekStreamTicket(ticket: string | undefined): boolean {
  if (!ticket) return false
  const exp = tickets.get(ticket)
  if (exp === undefined) return false
  if (exp <= Date.now()) {
    tickets.delete(ticket)
    return false
  }
  return true
}

/** 测试观测钩子（对齐 __setSpawnRunning 风格）：只读快照断言一次性语义 */
export function __getStreamTickets(): ReadonlyMap<string, number> {
  return tickets
}

/** 测试注入钩子：构造过期/异常态条目（生产零调用） */
export function __setStreamTicketForTest(ticket: string, expiresAt: number): void {
  tickets.set(ticket, expiresAt)
}

export function registerStreamTicketRoutes(): void {
  defineRoute('stream-ticket.post', {
    method: 'POST',
    path: '/api/stream-ticket',
    handler: (_ctx, req: IncomingMessage, res: ServerResponse) => {
      // 前端无 body 直发 POST——排空请求流（不消费会拖垮 keep-alive 连接复用）
      req.resume()
      reply(res, 200, issueTicket())
    },
  })
}
