/**
 * readJson body 异常生命周期两臂（闲置超时 + 断开兜底）——按被测行为归并的单文件。
 *
 * 合并自两份同壳回归（2026-09-26 测试资产行为化批；原文件名与用例数记档：
 * r51-g2-readjson-idle-timeout.test.ts 3 用例 + r55-readjson-clean-close.test.ts
 * 4 用例 → 7 用例零去重平移，断言面逐位保留）：
 *
 * - R51-G-2（五十一轮）：readJson body 闲置超时。修复前写端点按 CC-P2-9 在 readJson
 *   前同步占书级闸，客户端发完 headers 后悬持 body（慢速攻击/半开连接）可把闸悬到
 *   server 层 requestTimeout（300s）才释放，同书全部写端点此窗内恒 409。修复后：
 *   30s 零字节推进（可注入）即 408 'TIMEOUT'（与 client.ts 请求超时同码同形）+
 *   宽限后 destroy（R-1 同款收口）。
 * - R55-E-N（五十五轮）：readJson「断开无 error 形态」的 close 防御兜底。修复前
 *   readJson 只在 req 'error'（覆盖 ECONNRESET/EPIPE）与 'end' 路径 settle，
 *   `req.once('close')` 只清闲置计时器——客户端发部分 body 后干净半关闭（socket.end()，
 *   无 errno）时 promise 永不 settle：按 CC-P2-9 在 readJson 前同步占书级闸的端点
 *   （api/stream.ts holdSpawnGate、api/io.ts acquireTaskGate+跨进程锁文件）try 块
 *   永不退出，闸与锁文件（pid 活着不判 stale）悬挂到进程重启，同书全部写端点恒 409。
 *
 * 确定性改造记档（2026-09-26 批，固定 sleep → 确定性）：
 * - 3 处「写后等待」固定实睡 → setImmediate 让出让（数据事件/计时重置在让出拍内完成，
 *   断言语义不变）；
 * - 1 处真实 socket 半关闭前的固定垫（原 30ms）→ 服务侧 armed 握手（handler 进入
 *   readJson 前置旗，客户端 await 后再 FIN——就绪探针取代实睡，重评-0914-三轮 P3-12
 *   waitForBodyArmed 同口径）；
 * - 1 处应答到达等待（原 50ms 实睡后查一次）→ vi.waitFor 轮询；
 * - 保留 2 处：负窗断言（越过注入闲置 50ms + 宽限 60ms 窗捕捉迟到 destroy——证明
 *   「无」只能等满窗口，300ms 实睡为该窗的最小确定性形式）；真实 socket 结算截止
 *   （Promise.race 的 2s deadline 守卫，非节奏垫）。
 */
import http from 'node:http'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi } from 'vitest'

import { readJson, reply, isClientAbort, HttpError } from '../../src/studio/server/http.js'
import { acquireTaskGate, isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'
import { sleep } from '../helpers/wait-for.js'
import { listenSafe } from '../helpers/safe-port.js'

/** 让出数拍（setImmediate ×2）：待写数据事件 flush、readJson 计时器重置后再继续 */
async function yieldTicks(): Promise<void> {
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
}

describe('R51-G-2：readJson body 闲置超时（408 TIMEOUT）', () => {
  it('headers 后零字节推进 → 闲置到点 408 TIMEOUT + 宽限后 destroy', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 1024, 60, 50) // 注入小值保测试快：闲置 50ms / 宽限 60ms
    // 不写任何数据、不 end——修复前 promise 永不 settle（闸悬死），修复后闲置到点 408
    await expect(pending).rejects.toBeInstanceOf(HttpError)
    await expect(pending).rejects.toMatchObject({ status: 408, code: 'TIMEOUT' })
    // 408 响应刷出窗（宽限）到点强制断连，不再无限占 socket/FD
    await new Promise<void>((resolve) => stream.once('close', resolve))
    expect(stream.destroyed).toBe(true)
  })

  it('body 读到一半悬停（字节推进停止）→ 同样闲置 408，不因首字节已到而豁免', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 1024, 60, 50)
    stream.write(Buffer.from('{"content": "前半'))
    await yieldTicks() // 首字节已推进（计时已重置），此后悬停（原 sleep(20) 改让出拍）
    await expect(pending).rejects.toMatchObject({ status: 408, code: 'TIMEOUT' })
    stream.end()
  })

  it('字节推进重置计时：间隔小于闲置阈值的慢速 body 正常收全，不误伤', async () => {
    const stream = new PassThrough()
    // PassThrough autoDestroy 会记一次正常收口的 destroy——数次数防「闲置宽限的
    // 额外 destroy」（readjson-chunked R-1 用例同款手法）
    let destroyCalls = 0
    const origDestroy = stream.destroy.bind(stream)
    stream.destroy = (err?: Error | undefined) => {
      destroyCalls++
      return origDestroy(err)
    }
    const req = stream as unknown as IncomingMessage
    const body = Buffer.from(JSON.stringify({ content: '慢慢写完的正文' }))
    const half = Math.ceil(body.length / 2)
    // close 监听必须先于 await pending 注册：end 后 autoDestroy 的 close 可能抢在
    // promise 续延之前发出，事后再挂监听永远等不到第二次 close（悬挂根因）
    const closed = new Promise<void>((r) => stream.once('close', r))
    const pending = readJson(req, 1024, 60, 50)
    stream.write(body.subarray(0, half))
    await yieldTicks() // 间隔让出拍（≈0ms）< 闲置 50ms：每次 data 重置计时，永不触发（原 sleep(20) 改让出拍）
    stream.write(body.subarray(half))
    stream.end()
    const parsed = (await pending) as { content: string }
    expect(parsed.content).toBe('慢慢写完的正文')
    await closed
    const atClose = destroyCalls
    await sleep(300) // 负窗断言（保留）：越过闲置 50ms + 宽限 60ms 注入窗——修复前（end 不清闲置钟）此窗内必现迟到 destroy；证明「无新增」只能等满窗口
    expect(destroyCalls).toBe(atClose) // 无新增 destroy = 闲置钟已被 end/close 清掉
  })
})

describe('R55-E-N：readJson close 兜底（断开无 error 形态）', () => {
  it('body 读到一半 destroy()（close 触发、无 error、未 end）→ clientAbort reject（修复前悬挂）', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 1024, 60, 50)
    stream.write(Buffer.from('{"content": "前半'))
    await yieldTicks() // 数据事件 flush、悬在 readJson 中段（原 sleep(10) 改让出拍）
    // 干净销毁：'close' 触发、不发 'error'（对齐真实 socket FIN 的「无 errno」形态）
    stream.destroy()
    await expect(pending).rejects.toMatchObject({ clientAbort: true })
  })

  it('413 先 settle 后 destroy 收口：close 兜底为幂等空操作，413 不被覆盖', async () => {
    const stream = new PassThrough()
    const req = stream as unknown as IncomingMessage
    const pending = readJson(req, 32, 60, 50) // 32 字节上限
    stream.write(Buffer.from('x'.repeat(64))) // 超限 → 413 先 reject
    await expect(pending).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
    // 排空窗中途 destroy → close 触发（readableEnded=false）→ 兜底 reject 幂等无效
    stream.destroy()
    await expect(pending).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' })
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
    await yieldTicks() // 让 close 事件走完（原 sleep(10) 改让出拍）；已 settle 的 promise 对迟到 reject 免疫
    expect(parsed.content).toBe('完整正文')
  })
})

describe('R55-E-N：真实 socket 部分后 end()（干净 FIN）→ settle + 书级闸释放', () => {
  const BOOK = 'R55-E-N 闸书'

  it('readJson 以 clientAbort 错误 settle（非悬挂），占闸端点 try 块退出、闸可再占', async () => {
    // 端点侧观测面（对齐 api/io.ts /export 的「同步占闸 → try { await readJson } finally 释放」序）
    let settleInfo: Record<string, unknown> | null = null
    let onSettle: () => void = () => {}
    const settled = new Promise<void>((r) => {
      onSettle = r
    })

    // 服务侧就绪旗：handler 进入 readJson 前置位——客户端 await 后再 FIN（原 sleep(30)
    // 固定垫改 armed 握手，waitForBodyArmed 同口径的 socket 形态）
    let onArmed: () => void = () => {}
    const serverArmed = new Promise<void>((r) => {
      onArmed = r
    })

    const server = http.createServer(async (req, res) => {
      const release = acquireTaskGate(BOOK, 'export', { lockDir: null }) // 纯内存闸（测试注入 lockDir: null）
      if (!release) {
        reply(res, 409, { code: 'BUSY' })
        return
      }
      expect(isTaskGateHeld(BOOK, 'export')).toBe(true)
      let observed: Record<string, unknown>
      try {
        onArmed() // 已过闸、悬持 body 窗开启（就绪探针）
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
    await listenSafe(server)
    const { port } = server.address() as AddressInfo

    // 原生 net 客户端：headers + 部分 body，服务侧 armed 后干净半关闭（FIN，无 RST）
    const sock = net.connect(port, '127.0.0.1')
    let resp = ''
    sock.on('data', (d) => {
      resp += String(d)
    })
    sock.on('error', () => {})
    sock.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"partial":')
    await serverArmed
    sock.end()

    // readJson 必须在 2s 内 settle（修复前悬挂形态下此处超时跑红）
    const timeout = sleep(2000).then(() => {
      throw new Error('R55-E-N：readJson 2s 内未 settle（悬挂）')
    })
    await Promise.race([settled, timeout])

    expect(settleInfo!.settled).toBe('reject')
    // 关键断言：带 clientAbort 标记（error 臂与 close 兜底臂收敛点）——dispatch 兜底据此降 info 日志
    expect(settleInfo!.clientAbort).toBe(true)

    // 书级闸已随 handler try 块退出而释放（可再占；占后立即还，防污染同文件后案）
    const again = acquireTaskGate(BOOK, 'export', { lockDir: null })
    expect(again).not.toBeNull()
    again?.()

    // 连接以 HTTP 应答收口（观测回执或 llhttp 对 aborted 请求的自动 400 信封——
    // 400 由 server 内核抢先占用 socket，属运行时行为；实质断言在上方服务侧观测面）。
    // 原固定实睡 50ms 后查一次 → vi.waitFor 轮询（确定性）
    await vi.waitFor(() => expect(resp).toMatch(/^HTTP\/1\.1 \d{3}/))

    sock.destroy()
    await new Promise<void>((r) => server.close(() => r()))
  })
})
