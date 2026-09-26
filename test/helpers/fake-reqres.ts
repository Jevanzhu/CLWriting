/**
 * 测试精简批（2026-09-12，台账重评-0912-3 #54 fakeReqRes 三份收编）：
 * 假 req/res 单一真相源——迁自 r1010b-srv-documents-bookmoved / srv-write-bookmoved-guard /
 * r0912-acknowledge-endpoint 三份逐字相同的本地拷贝（「对齐 error-envelope 先例」原注释保留）。
 *
 * 假 req（EventEmitter 手工喂 data/end；readJson 的闲置 30s 窗内挂持即「入口已过、
 * 单元未跑」确定性窗口）+ 假 res（捕获状态码与信封体）。
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitFor } from './wait-for.js'

/**
 * readJson 挂持就绪探针（重评-0914-三轮 P3-12）：data 监听已挂上 = handler 已悬在
 * readJson（src/studio/server/http.ts readJson 进函数即 `req.on('data', …)`）——
 * 此时入口快照（resolveBook）必已过、body 未到，正是「入口已过、单元未跑」窗口。
 * 取代 `await sleep(50)` 定时假定：假 req 事件无缓冲，慢 CI 下早放 body 会丢失，
 * 轮询到就绪信号再放行（r1010b 面 B 观测钩子轮询同型手法，waitFor 单源）。
 */
export async function waitForBodyArmed(req: IncomingMessage, timeoutMs = 3000): Promise<void> {
  await waitFor(() => req.listenerCount('data') > 0, timeoutMs, 5, 'readJson 挂持（假 req data 监听未武装）')
}

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
