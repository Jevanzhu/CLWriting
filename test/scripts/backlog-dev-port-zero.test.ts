/**
 * R59 清偿批（R55-E-3）回归：CLW_DEV_API_PORT=0 显式拒绝。
 *
 * 修复前：resolveDevApiPort 校验下界是 n < 0，'0' 被当合法端口透传——listen(0)
 * 落在随机端口，而 Vite dev 代理目标固定 7878（或 CLW_DEV_API_PORT 声明值），
 * dev 页面 /api 全部静默失联（502/超时）且零提示。
 *
 * 修复后：'0' 并入既有非法值 fatal 通道（人话消息点名 env 名 + 取值域 1–65535，
 * 注入 fatal 时回落缺省 7878、生产 console.error + exit 2）。选 fail-loud 而非
 * warn+回落：与该文件既有非法值契约同通道、改动面最小，且不静默替换显式设置。
 * 桌面端 resolveEnvPort（R39-9）允许 0 的口径不受影响（彼处无固定代理前提）。
 */
import { describe, it, expect } from 'vitest'
import {
  DEV_API_PORT_ENV,
  DEV_API_DEFAULT_PORT,
  resolveDevApiPort,
} from '../../src/studio/server/dev-port.js'

describe('R55-E-3：CLW_DEV_API_PORT=0 拒绝（dev 链路防静默失联）', () => {
  it("'0' → fatal 人话消息（点名 env 名与 1–65535 取值域），回落缺省 7878", () => {
    const fatals: string[] = []
    const port = resolveDevApiPort({ [DEV_API_PORT_ENV]: '0' }, { fatal: (m) => fatals.push(m) })
    expect(port).toBe(DEV_API_DEFAULT_PORT)
    expect(fatals).toHaveLength(1)
    expect(fatals[0]).toContain(DEV_API_PORT_ENV)
    expect(fatals[0]).toContain('0')
    expect(fatals[0]).toContain('1–65535')
  })

  it("'0' 走生产通道时同样拒绝（console.error + exit 2，不透传 0）", () => {
    // 未注入 fatal 时内部 console.error + process.exit(2)——stub 以抛错模拟进程
    // 终止（真 exit 不返回；若 stub 平返回，函数会穿透到 `return n` 失真）
    const exits: Array<number | string | undefined> = []
    const errSpy = console.error
    const exitSpy = process.exit
    console.error = () => {}
    process.exit = ((code?: number | string | undefined) => {
      exits.push(code)
      throw new Error('EXIT_SENTINEL')
    }) as typeof process.exit
    try {
      expect(() => resolveDevApiPort({ [DEV_API_PORT_ENV]: '0' })).toThrow('EXIT_SENTINEL')
      expect(exits).toEqual([2])
    } finally {
      console.error = errSpy
      process.exit = exitSpy
    }
  })

  it('下界收紧不误伤：1 与 65535 仍合法透传', () => {
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '1' })).toBe(1)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '65535' })).toBe(65535)
    expect(resolveDevApiPort({})).toBe(DEV_API_DEFAULT_PORT)
  })
})
