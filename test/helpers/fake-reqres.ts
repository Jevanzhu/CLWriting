/**
 * 测试精简批（2026-09-12，台账重评-0912-3 #54 fakeReqRes 三份收编）：
 * 假 req/res 单一真相源——迁自 r1010b-srv-documents-bookmoved / r0911-srv-write-bookmoved /
 * r0912-acknowledge-endpoint 三份逐字相同的本地拷贝（「对齐 error-envelope 先例」原注释保留）。
 *
 * 假 req（EventEmitter 手工喂 data/end；readJson 的闲置 30s 窗内挂持即「入口已过、
 * 单元未跑」确定性窗口）+ 假 res（捕获状态码与信封体）。
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

export function fakeReqRes(): {
  req: IncomingMessage
  res: ServerResponse
  send: (body: unknown) => void
  captured: { status: number | null; body: string }
} {
  const em = new EventEmitter()
  const req = em as unknown as IncomingMessage
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  const captured = { status: null as number | null, body: '' }
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(body?: string) {
      captured.body = body ?? ''
    },
  } as unknown as ServerResponse
  return {
    req,
    res,
    send: (body: unknown) => {
      em.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'))
      em.emit('end')
    },
    captured,
  }
}
