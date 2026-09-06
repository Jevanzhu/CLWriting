/**
 * R57-C-1（五十七轮）回归：静态文件流「close 早于 open」FD 悬挂微竞态。
 *
 * static.ts 的 GET 流式分支此前把 res 'close'（→ stream.destroy()）监听注册在
 * stream 'open' 回调内：res 在 open 触发前已 close（客户端拿到响应头前早断）时，
 * 迟注册的监听永不触发，读流 open 后无接管对象也无销毁通道 → 文件描述符悬挂至
 * GC。修复：close 监听在 createReadStream 后同步注册（open 回调外），open 回调加
 * destroyed 守卫（close 先至已收口的流不再写头/接管，open 迟到竞态也无双重销毁）。
 *
 * 手法：沿用 test/studio/static.test.ts 重评-4 用例的 mock 惯例——vi.mock('node:fs')
 * 透传 spy + mockImplementationOnce 注入受控源流假件（open 时机由测试手动控时），
 * res 用真 PassThrough 承接 pipe、writeHead 桩替身，直调 handler。
 */
import http from 'node:http'
import type { ReadStream } from 'node:fs'
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createStaticHandler } from '../../src/studio/server/static.js'

// R57-C-1：createReadStream 透传 spy（默认行为不变），用例内 mockImplementationOnce
// 注入受控源流——「res close 先于流 open」的时序唯有可控假件能确定性构造
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})
const createReadStreamMock = vi.mocked(createReadStream)

/** 受控源流假件（static.ts 只消费 on/pipe/destroy 面 + destroyed 判读） */
class FakeSource extends EventEmitter {
  destroyed = false
  destroyCount = 0
  pipedTo: unknown = null
  destroy(): this {
    this.destroyCount++
    this.destroyed = true
    return this
  }
  pipe(dest: unknown): unknown {
    this.pipedTo = dest
    return dest
  }
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clwriting-r57-static-'))
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>Studio</title>')
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 真 PassThrough 承接 pipe + writeHead 桩替身（对齐 static.test.ts 重评-4 手法） */
function mkReqRes(): {
  req: http.IncomingMessage
  res: http.ServerResponse
  writeHeadSpy: ReturnType<typeof vi.fn>
} {
  const res = new PassThrough() as unknown as http.ServerResponse
  const writeHeadSpy = vi.fn()
  ;(res as unknown as { writeHead: unknown }).writeHead = writeHeadSpy
  const req = { method: 'GET', url: '/app.js' } as unknown as http.IncomingMessage
  return { req, res, writeHeadSpy }
}

describe('R57-C-1: 静态流 close 早于 open 的 FD 悬挂微竞态', () => {
  // 核心回归：close 先到、open 后到——修复前 close 监听尚在 open 回调里未注册，
  // 流永不被销毁（悬挂）；修复后同步注册的监听立即收口，open 迟到不再接管
  test('res close 先于流 open（客户端早断）→ 流同步销毁收口，open 迟到不再写头/接管', async () => {
    writeFileSync(join(root, 'app.js'), 'console.log(1)')
    const source = new FakeSource()
    createReadStreamMock.mockImplementationOnce(() => source as unknown as ReadStream)
    const { req, res, writeHeadSpy } = mkReqRes()

    await createStaticHandler(root)(req, res) // 注册完 open/error 监听即返回；open 由假件控时

    res.emit('close') // 客户端早断：close 先到
    source.emit('open', 1) // 流 open 迟到（竞态窗）

    expect(source.destroyed).toBe(true) // 修复锚点：流已被收口销毁（修复前悬挂）
    expect(source.destroyCount).toBe(1) // 幂等：无双重销毁
    expect(writeHeadSpy).not.toHaveBeenCalled() // open 迟到不向已断连 res 写头
    expect(source.pipedTo).toBeNull() // 不接管
  })

  // 对照：常规时序（open 先、close 后）语义不回归——照常写头接管，close 后销毁一次
  test('open 先于 close（常规断连）→ pipe 照常接管，close 后销毁一次（重评-4 语义不回归）', async () => {
    writeFileSync(join(root, 'app.js'), 'console.log(1)')
    const source = new FakeSource()
    createReadStreamMock.mockImplementationOnce(() => source as unknown as ReadStream)
    const { req, res, writeHeadSpy } = mkReqRes()

    await createStaticHandler(root)(req, res)

    source.emit('open', 1)
    expect(writeHeadSpy).toHaveBeenCalledTimes(1)
    expect(source.pipedTo).toBe(res) // 照常接管
    res.emit('close')
    expect(source.destroyed).toBe(true)
    expect(source.destroyCount).toBe(1) // 单次销毁（幂等无重复）
  })

  // 对照：open 前流错误 → 500 信封照常（N-3 口径），replyError 收尾触发的 res close
  // 走同步注册的销毁通道且不重复（真实流上 destroy-after-error 是 no-op，不炸）
  test('open 前流 error → 500 信封照常，close 后销毁通道单次收口', async () => {
    writeFileSync(join(root, 'app.js'), 'console.log(1)')
    const source = new FakeSource()
    createReadStreamMock.mockImplementationOnce(() => source as unknown as ReadStream)
    const { req, res, writeHeadSpy } = mkReqRes()

    await createStaticHandler(root)(req, res)

    source.emit('error', Object.assign(new Error('EACCES（模拟）'), { code: 'EACCES' }))
    expect(writeHeadSpy.mock.calls[0]?.[0]).toBe(500) // N-3：IO 信封（未写过头）
    // 真 ServerResponse 在 end/连接关闭后必发 'close'；PassThrough 桩含未读缓冲不会
    // 自动发（对齐重评-4 用例的手动控时惯例）
    res.emit('close')
    expect(source.destroyed).toBe(true)
    expect(source.destroyCount).toBe(1)
  })
})
