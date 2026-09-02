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
  resolveEnvPort,
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

  // R26-94（二十六轮）：--port 空串/非数值从「静默落缺省」改为 fatal 报错（人话文案）。
  // 注入 fatal 捕获件（不退出）→ 后续按「--port 未提供」回落缺省端口——不透传 NaN 进
  // listen 的旧契约保留，新增「拼错参数必须有人看见」的显式出口。
  it('--port 非数字 → fatal 报错 + 回落缺省（不透传 NaN 进 listen）', () => {
    const fatal = vi.fn()
    const r = parseServerArgs(['x', '--port', 'abc'], { fatal })
    expect(fatal).toHaveBeenCalledTimes(1)
    expect(String(fatal.mock.calls[0]![0])).toContain('--port')
    expect(r.port).toBe(0)
  })

  it('--port 空串 → fatal 报错（Number(\'\')===0 的静默随机端口形态已收口）', () => {
    const fatal = vi.fn()
    parseServerArgs(['x', '--port', ''], { fatal })
    expect(fatal).toHaveBeenCalledTimes(1)
  })

  // R28-19（二十八轮）：负数/越界/小数原校验 Number.isFinite 放行，落 server.listen()
  // 同步抛 RangeError 绕开 boot-error 信封（utilityProcess 子进程内成无因由退出）。
  // 补整数 + 0–65535 界域判定后三形态一律走既有 fatal 人话通道；注入 fatal 不退出的
  // 既有契约保留——回落「--port 未提供」的缺省端口。
  describe('R28-19：--port 越界/非整数补全', () => {
    it.each(['-1', '65536', '78.5'])('--port %s → fatal 人话报错 + 回落缺省端口（不透传进 listen）', (raw) => {
      const fatal = vi.fn()
      const r = parseServerArgs(['x', '--port', raw], { fatal })
      expect(fatal).toHaveBeenCalledTimes(1)
      const msg = String(fatal.mock.calls[0]![0])
      expect(msg).toContain('--port')
      expect(msg).toContain(raw) // 人话文案回显原值，拼错参数有人看见
      expect(msg).toContain('0–65535') // 界域口径如实
      expect(r.port).toBe(0)
    })

    it('边界合法值放行：0 与 65535 不触发 fatal（随机端口/端口上限仍在域内）', () => {
      const fatal = vi.fn()
      expect(parseServerArgs(['x', '--port', '0'], { fatal }).port).toBe(0)
      expect(parseServerArgs(['x', '--port', '65535'], { fatal }).port).toBe(65535)
      expect(fatal).not.toHaveBeenCalled()
    })
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

describe('R39-9（三十九轮）：resolveEnvPort（env 侧端口校验，与 argv 侧 R26-94/R28-19 同口径）', () => {
  it('未设 → 7878；合法值透传（0 与 65535 边界含，首尾空白容忍）', () => {
    expect(resolveEnvPort({})).toBe(7878)
    expect(resolveEnvPort({ CLWRITING_PORT: '7878' })).toBe(7878)
    expect(resolveEnvPort({ CLWRITING_PORT: '0' })).toBe(0)
    expect(resolveEnvPort({ CLWRITING_PORT: '65535' })).toBe(65535)
    expect(resolveEnvPort({ CLWRITING_PORT: ' 9000 ' })).toBe(9000)
  })

  it('非法值走 fatal 人话通道并回落缺省（注入件不退出口径），NaN/空串不再透传 listen', () => {
    const fatals: string[] = []
    const fatal = (msg: string): void => {
      fatals.push(msg)
    }
    for (const bad of ['abc', '', '-1', '65536', '78.5']) {
      expect(resolveEnvPort({ CLWRITING_PORT: bad }, { fatal })).toBe(7878)
    }
    expect(fatals).toHaveLength(5)
    expect(fatals[0]).toContain('CLWRITING_PORT')
    expect(fatals[0]).toContain('0–65535')
  })
})
