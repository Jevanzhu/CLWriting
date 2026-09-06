/**
 * R51-G-2（五十一轮）回归：readJson body 闲置超时。
 *
 * 修复前：写端点按 CC-P2-9 在 readJson 前同步占书级闸，客户端发完 headers 后悬持
 * body（慢速攻击/半开连接）可把闸悬到 server 层 requestTimeout（300s）才释放，
 * 同书全部写端点此窗内恒 409。修复后：30s 零字节推进（可注入）即 408 'TIMEOUT'
 *（与 client.ts 请求超时同码同形）+ 宽限后 destroy（R-1 同款收口）。
 * 手法：本目录 readjson-chunked.test.ts 既有 PassThrough 夹具 + destroy 计数形态。
 */
import { PassThrough } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { describe, it, expect } from 'vitest'
import { readJson, HttpError } from '../../src/studio/server/http.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
    await sleep(20) // 首字节已推进（计时已重置），此后悬停
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
    await sleep(20) // 间隔 20ms < 闲置 50ms：每次 data 重置计时，永不触发
    stream.write(body.subarray(half))
    stream.end()
    const parsed = (await pending) as { content: string }
    expect(parsed.content).toBe('慢慢写完的正文')
    await closed
    const atClose = destroyCalls
    await sleep(300) // 越过闲置阈值 + 宽限：修复前（end 不清闲置钟）此窗内必现迟到 destroy
    expect(destroyCalls).toBe(atClose) // 无新增 destroy = 闲置钟已被 end/close 清掉
  })
})
