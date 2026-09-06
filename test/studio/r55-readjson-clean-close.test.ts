/**
 * R55-E-N（五十五轮）回归：readJson「断开无 error 形态」的 close 防御兜底。
 *
 * 修复前：readJson 只在 req 'error'（覆盖 ECONNRESET/EPIPE）与 'end' 路径 settle，
 * `req.once('close')` 只清闲置计时器——客户端发部分 body 后干净半关闭（socket.end()，
 * 无 errno）时 promise 永不 settle：按 CC-P2-9 在 readJson 前同步占书级闸的端点
 *（api/stream.ts holdSpawnGate、api/io.ts acquireTaskGate+跨进程锁文件）try 块永不
 * 退出，闸与锁文件（pid 活着不判 stale）悬挂到进程重启，同书全部写端点恒 409。
 *
 * 手法（两层）：
 * - 单元红驱动：PassThrough 假 req（本目录 readjson-chunked / r51-g2 / client-abort-log
 *   既有手法）中途 destroy()——精确复刻「close 触发、无 'error'、未 end」形态（时序
 *   全同步可控，不依赖运行时对 FIN 的 errno 表现差异），修复前 promise 悬挂跑红。
 * - 真实 socket 锚：node:http + node:net 原生链路，客户端写部分 body 后 socket.end()
 *   （干净 FIN，无 RST），断言 readJson 必然 settle（运行时 error 先行时走 error 臂、
 *   无 error 形态时走 close 兜底臂——两臂均带 clientAbort 标记收敛到同一断言），且按
 *   io.ts /export 同款占闸序（readJson 前同步 acquireTaskGate）占的书级闸被释放。
 */
import http from 'node:http'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect } from 'vitest'

import { readJson, reply, isClientAbort } from '../../src/studio/server/http.js'
import { acquireTaskGate, isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('R55-E-N：readJson close 兜底（断开无 error 形态）', () => {
  it('body 读到一半 destroy()（close 触发、无 error、未 end）→ clientAbort reject（修复前悬挂）', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 1024, 60, 50)
    stream.write(Buffer.from('{"content": "前半'))
    await sleep(10)
    // 干净销毁：'close' 触发、不发 'error'（对齐真实 socket FIN 的「无 errno」形态）
    stream.destroy()
    await expect(pending).rejects.toMatchObject({ clientAbort: true })
  })

  it('413 先 settle 后 destroy 收口：close 兜底为幂等空操作，413 不被覆盖', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 32, 60, 50) // 32 字节上限
    stream.write(Buffer.from('x'.repeat(64))) // 超限 → 413 先 reject
    await expect(pending).rejects.toMatchObject({ status: 413, code: 'BAD_INPUT' })
    // 排空窗中途 destroy → close 触发（readableEnded=false）→ 兜底 reject 幂等无效
    stream.destroy()
    await expect(pending).rejects.toMatchObject({ status: 413, code: 'BAD_INPUT' })
  })

  it('正常收齐 body 后 close（readableEnded=true）→ 结果不受影响', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 1024, 60, 50)
    stream.write(Buffer.from(JSON.stringify({ content: '完整正文' })))
    stream.end()
    const parsed = (await pending) as { content: string }
    expect(parsed.content).toBe('完整正文')
    // 正常收口后再 destroy：readableEnded=true → 兜底臂不触发，已 resolve 的 promise 不受影响
    stream.destroy()
    await sleep(10)
    expect(parsed.content).toBe('完整正文')
  })
})

describe('R55-E-N：真实 socket 部分后 end()（干净 FIN）→ settle + 书级闸释放', () => {
  const BOOK = 'R55-E-N 闸书'

  it('readJson 以 clientAbort 错误 settle（非悬挂），占闸端点 try 块退出、闸可再占', async () => {
    // 端点侧观测面（对齐 api/io.ts /export 的「同步占闸 → try { await readJson } finally 释放」序）
    let settleInfo: Record<string, unknown> | null = null
    let onSettle: () => void = () => {}
    const settled = new Promise<void>((r) => { onSettle = r })

    const server = http.createServer(async (req, res) => {
      const release = acquireTaskGate(BOOK, 'export', { lockDir: null }) // 纯内存闸（测试注入 lockDir: null）
      if (!release) {
        reply(res, 409, { code: 'BUSY' })
        return
      }
      expect(isTaskGateHeld(BOOK, 'export')).toBe(true)
      let observed: Record<string, unknown>
      try {
        await readJson(req)
        observed = { settled: 'resolve' }
      } catch (e) {
        observed = {
          settled: 'reject',
          clientAbort: isClientAbort(e),
          code: (e as { code?: string }).code ?? null,
        }
      } finally {
        release() // 修复前（悬挂形态）永不可达
      }
      settleInfo = observed
      onSettle()
      reply(res, 200, observed) // 干净半关闭只关写侧，客户端读侧仍可收观测回执
    })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    const { port } = server.address() as AddressInfo

    // 原生 net 客户端：headers + 部分 body，30ms 后干净半关闭（FIN，无 RST）
    const sock = net.connect(port, '127.0.0.1')
    let resp = ''
    sock.on('data', (d) => { resp += String(d) })
    sock.on('error', () => {})
    sock.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"partial":')
    await sleep(30)
    sock.end()

    // readJson 必须在 2s 内 settle（修复前悬挂形态下此处超时跑红）
    const timeout = sleep(2000).then(() => { throw new Error('R55-E-N：readJson 2s 内未 settle（悬挂）') })
    await Promise.race([settled, timeout])

    expect(settleInfo!.settled).toBe('reject')
    // 关键断言：带 clientAbort 标记（error 臂与 close 兜底臂收敛点）——dispatch 兜底据此降 info 日志
    expect(settleInfo!.clientAbort).toBe(true)

    // 书级闸已随 handler try 块退出而释放（可再占；占后立即还，防污染同文件后案）
    const again = acquireTaskGate(BOOK, 'export', { lockDir: null })
    expect(again).not.toBeNull()
    again?.()

    // 连接以 HTTP 应答收口（观测回执或 llhttp 对 aborted 请求的自动 400 信封——
    // 400 由 server 内核抢先占用 socket，属运行时行为；实质断言在上方服务侧观测面）
    await sleep(50)
    expect(resp).toMatch(/^HTTP\/1\.1 \d{3}/)

    sock.destroy()
    await new Promise<void>((r) => server.close(() => r()))
  })
})
