/**
 * 阶段 22 批 U1：server-boot 共享核心回归（server-main 与 server-utility 两入口
 * 单一真相源的等价性锚定，U-3）。
 *
 * - 参数解析：--dir 缺省 = welcome 态（S-8）/ --book/--user-data/--port/
 *   --mirror-console 三态语义（缺省透传 undefined 走 startServer 内部缺省）；
 *   token 只经 env CLW_STUDIO_TOKEN（E-9b：不经 argv——本机 ps 可见）
 * - bootServerFromArgs：--book → setInitialBook 先于 startServer（U-1 调用序铁律）
 * - listening → onReady(实际端口)；error → onBootError（信封化回调接线）
 * - describeBootError：EADDRINUSE 中文信封（server-main 拆分前口径原样保留）
 * - deriveStaticDir：入口产物相对派生 dist/web（R-6 同款先例）
 */
import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  parseServerArgs,
  bootServerFromArgs,
  describeBootError,
  deriveStaticDir,
} from '../../src/desktop/server-boot.js'
import type { StudioServerOptions } from '../../src/studio/server/index.js'

/** 真 http.Server 实例（不监听）——结构类型零 cast，握手事件手动派发 */
function fakeServer(port = 45678): http.Server {
  const s = http.createServer((_req, res) => {
    res.end()
  })
  s.address = () => ({ address: '127.0.0.1', family: 'IPv4', port })
  return s
}

describe('批 U1：parseServerArgs', () => {
  it('全参数解析', () => {
    const p = parseServerArgs(
      [
        'node', 'x.js',
        '--dir', '/books/lib',
        '--user-data', '/ud',
        '--port', '8123',
        '--book', '书A',
        '--mirror-console',
      ],
      // E-9b：token 只经 env 注入（隔离宿主环境，不走 process.env 缺省）
      { env: { CLW_STUDIO_TOKEN: 'tkn-1' } },
    )
    expect(p).toEqual({
      port: 8123,
      workDir: '/books/lib',
      userDataPath: '/ud',
      book: '书A',
      token: 'tkn-1',
      mirrorConsole: true,
    })
  })

  it('缺省：port 0 / 其余 null / mirrorConsole null（welcome 态，S-8）', () => {
    const p = parseServerArgs(['node', 'x.js'], { env: {} })
    expect(p).toEqual({ port: 0, workDir: null, userDataPath: null, book: null, token: null, mirrorConsole: null })
  })

  it('E-9b：token 彻底切 env——argv 残留 --token 也不解析（本机 ps 可见面收敛）', () => {
    // argv 带旧 --token：不再被识别（未识别参数忽略），token 仍只看 env
    const p = parseServerArgs(['x', '--token', 'argv-tkn'], { env: {} })
    expect(p.token).toBeNull()
    expect(parseServerArgs(['x'], { env: { CLW_STUDIO_TOKEN: 'env-tkn' } }).token).toBe('env-tkn')
    // env 空串按未提供处理（?? null），不把 '' 透传给 startServer
    expect(parseServerArgs(['x'], { env: { CLW_STUDIO_TOKEN: '' } }).token).toBeNull()
  })

  // N-8（第五十四轮）：argv 残留 --token 打 warn（不报错不退出）——外部脚本（如
  // release-smoke 直跑 server-main）不会静默拿到随机 token
  it('N-8：argv 出现 --token → warn 一次（可注入捕获件），解析仍正常不抛错', () => {
    const warn = vi.fn()
    const p = parseServerArgs(['x', '--token', 'argv-tkn', '--port', '9'], { env: { CLW_STUDIO_TOKEN: 'tkn' }, warn })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('--token')
    expect(p.token).toBe('tkn') // token 仍以 env 为准，argv 值被忽略
    expect(p.port).toBe(9) // 其余解析不受影响，不报错不退出
    // 无 --token 时零 warn
    const warn2 = vi.fn()
    parseServerArgs(['x', '--port', '9'], { env: {}, warn: warn2 })
    expect(warn2).not.toHaveBeenCalled()
  })

  it('portDefault：未传 --port 时回落入口自定义缺省（server-main 7878）', () => {
    expect(parseServerArgs(['x'], { portDefault: 7878 }).port).toBe(7878)
    expect(parseServerArgs(['x', '--port', '9'], { portDefault: 7878 }).port).toBe(9)
  })

  it('--port 非数字 → 缺省（不透传 NaN 进 listen）', () => {
    expect(parseServerArgs(['x', '--port', 'abc']).port).toBe(0)
  })
})

describe('批 U1：bootServerFromArgs（依赖注入假件）', () => {
  it('--book → setInitialBook 先于 startServer（U-1 调用序铁律）', () => {
    const setInitialBook = vi.fn()
    const startServer = vi.fn((_opts: StudioServerOptions) => fakeServer())
    bootServerFromArgs(
      { port: 0, workDir: '/w', userDataPath: '/ud', book: '书A', token: null, mirrorConsole: null },
      '/static',
      { onReady: () => {}, onBootError: () => {} },
      { setInitialBook, startServer },
    )
    expect(setInitialBook).toHaveBeenCalledTimes(1)
    expect(setInitialBook).toHaveBeenCalledWith('书A')
    expect(setInitialBook.mock.invocationCallOrder[0]).toBeLessThan(startServer.mock.invocationCallOrder[0]!)
  })

  it('无 --book → setInitialBook 不调用（缺省行为不变）', () => {
    const setInitialBook = vi.fn()
    const startServer = vi.fn((_opts: StudioServerOptions) => fakeServer())
    bootServerFromArgs(
      { port: 0, workDir: null, userDataPath: null, book: null, token: null, mirrorConsole: null },
      '/static',
      { onReady: () => {}, onBootError: () => {} },
      { setInitialBook, startServer },
    )
    expect(setInitialBook).not.toHaveBeenCalled()
  })

  it('token 注入 / 缺省 undefined 走 startServer 内部 randomUUID（U-6 等价口径；E-9b 后注入面为 env）', () => {
    const startServer = vi.fn((_opts: StudioServerOptions) => fakeServer())
    bootServerFromArgs(
      { port: 0, workDir: null, userDataPath: null, book: null, token: 'tkn-fixed', mirrorConsole: null },
      '/static',
      { onReady: () => {}, onBootError: () => {} },
      { startServer },
    )
    expect(startServer.mock.calls[0]![0].studioToken).toBe('tkn-fixed')
    startServer.mockClear()
    bootServerFromArgs(
      { port: 0, workDir: null, userDataPath: null, book: null, token: null, mirrorConsole: null },
      '/static',
      { onReady: () => {}, onBootError: () => {} },
      { startServer },
    )
    expect(startServer.mock.calls[0]![0].studioToken).toBeUndefined()
    expect(startServer.mock.calls[0]![0].mirrorConsoleLog).toBeUndefined()
  })

  it('mirrorConsole 三态：flag → true / 未传 → undefined（startServer 缺省 true 语义不变）', () => {
    const startServer = vi.fn((_opts: StudioServerOptions) => fakeServer())
    bootServerFromArgs(
      { port: 0, workDir: null, userDataPath: null, book: null, token: null, mirrorConsole: true },
      '/static',
      { onReady: () => {}, onBootError: () => {} },
      { startServer },
    )
    expect(startServer.mock.calls[0]![0].mirrorConsoleLog).toBe(true)
  })

  it('listening → onReady(实际端口)；error → onBootError', () => {
    const s = fakeServer(45123)
    const onReady = vi.fn()
    const onBootError = vi.fn()
    bootServerFromArgs(
      { port: 0, workDir: null, userDataPath: null, book: null, token: null, mirrorConsole: null },
      '/static',
      { onReady, onBootError },
      { startServer: () => s },
    )
    s.emit('listening')
    expect(onReady).toHaveBeenCalledWith(45123)
    const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    s.emit('error', err)
    expect(onBootError).toHaveBeenCalledWith(err)
  })
})

describe('批 U1：describeBootError（boot-error 信封）', () => {
  it('EADDRINUSE → code + 中文口径（server-main 拆分前文案原样）', () => {
    const e = describeBootError(Object.assign(new Error('listen EADDRINUSE :::7878'), { code: 'EADDRINUSE' }), 7878)
    expect(e.code).toBe('EADDRINUSE')
    expect(e.message).toContain('端口 7878 已被占用（EADDRINUSE）')
    expect(e.message).toContain('--port')
  })

  it('其他错误 → 通用信封；非 Error 值收编字符串；无 code → UNKNOWN', () => {
    expect(describeBootError(new Error('boom'), 1).code).toBe('UNKNOWN')
    expect(describeBootError(new Error('boom'), 1).message).toContain('server 启动失败：boom')
    expect(describeBootError('裸字符串', 1).message).toContain('裸字符串')
  })
})

describe('批 U1：deriveStaticDir', () => {
  // Windows 无 POSIX 分隔且 file:///app/ 非绝对 URL：用 resolve+pathToFileURL 构造
  // 平台绝对 module URL，期望以 fileURLToPath+join 同源推导——仅锁「dist 同级 web」相对语义，
  // win 与 mac/linux 各按本平台分隔符解析
  it('入口产物相对派生：dist/desktop/*.js → dist/web（asar 内同款，R-6）', () => {
    const ut = pathToFileURL(resolve('dist', 'desktop', 'server-utility.js')).href
    const main = pathToFileURL(resolve('dist', 'desktop', 'server-main.js')).href
    expect(deriveStaticDir(ut)).toBe(join(dirname(dirname(fileURLToPath(ut))), 'web'))
    expect(deriveStaticDir(main)).toBe(join(dirname(dirname(fileURLToPath(main))), 'web'))
  })
})
