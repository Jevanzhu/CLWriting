/**
 * R51-J-3（五十一轮）回归：dev-api 端口 env 单源（CLW_DEV_API_PORT）。
 *
 * 修复前：scripts/dev-api.ts 顶部 PORT 字面量写死 7878，EADDRINUSE 指引「改脚本顶部
 * PORT」——而 Vite 代理目标也固定 7878，照做即 dev 页面 /api 全 502（死胡同）。
 * 修复后：解析逻辑抽 src/studio/server/dev-port.ts 纯模块（dev-api.ts 顶层 startServer
 * 有模块加载副作用，不抽离无法单测），listen/banner/指引文案同源读。
 */
import { describe, it, expect } from 'vitest'
import {
  DEV_API_PORT_ENV,
  DEV_API_DEFAULT_PORT,
  resolveDevApiPort,
} from '../../src/studio/server/dev-port.js'

describe('R51-J-3：resolveDevApiPort（env 单源）', () => {
  it('未设 env → 缺省 7878（与 Vite 代理目标一致）', () => {
    expect(DEV_API_PORT_ENV).toBe('CLW_DEV_API_PORT')
    expect(resolveDevApiPort({})).toBe(DEV_API_DEFAULT_PORT)
    expect(DEV_API_DEFAULT_PORT).toBe(7878)
  })

  it('合法 0–65535 整数透传（含 0 随机端口与边界值）', () => {
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '8081' })).toBe(8081)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '0' })).toBe(0)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '65535' })).toBe(65535)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: ' 7878 ' })).toBe(7878) // 首尾空白容忍（R39-9 同口径）
  })

  it('非法值 → fatal 人话消息点名 env 名，回落缺省（注入 fatal 不真退进程）', () => {
    const fatals: string[] = []
    const fatal = (msg: string): void => {
      fatals.push(msg)
    }
    for (const bad of ['abc', '', '-1', '65536', '80.5']) {
      fatals.length = 0
      const port = resolveDevApiPort({ [DEV_API_PORT_ENV]: bad }, { fatal })
      expect(port).toBe(DEV_API_DEFAULT_PORT)
      expect(fatals).toHaveLength(1)
      expect(fatals[0]).toContain(DEV_API_PORT_ENV)
      expect(fatals[0]).toContain(bad)
    }
  })
})
