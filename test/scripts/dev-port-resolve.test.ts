/**
 * dev-api 端口 env 单源（CLW_DEV_API_PORT）解析契约：resolveDevApiPort。
 *
 * 档源：原 r51-j3-dev-api-port.test.ts（R51-J-3 env 单源）与
 * backlog-dev-port-zero.test.ts（R55-E-3 '0' 拒绝）同属 dev-port 解析一族，
 * 按被测行为合并；断言逐条保留，去重 1 处（1/65535 边界透传两档重复，保留
 * R51-J-3 组含首尾空白容忍的版本）。
 *
 * - R51-J-3（五十一轮）：scripts/dev-api.ts 顶部 PORT 字面量写死 7878，EADDRINUSE
 *   指引「改脚本顶部 PORT」——而 Vite 代理目标也固定 7878，照做即 dev 页面 /api 全
 *   502（死胡同）。修复后：解析逻辑抽 src/studio/server/dev-port.ts 纯模块。
 * - R55-E-3（R59 清偿批）：'0' 从合法集移入非法集——修复前 resolveDevApiPort 校验
 *   下界是 n < 0，'0' 被当合法端口透传——listen(0) 落在随机端口，而 Vite dev 代理
 *   目标固定 7878（或 CLW_DEV_API_PORT 声明值），dev 页面 /api 全部静默失联（502/
 *   超时）且零提示。选 fail-loud 而非 warn+回落：与该文件既有非法值契约同通道、
 *   改动面最小，且不静默替换显式设置。桌面端 resolveEnvPort（R39-9）允许 0 的口径
 *   不受影响（彼处无固定代理前提）。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DEV_API_PORT_ENV,
  DEV_API_DEFAULT_PORT,
  resolveDevApiPort,
} from '../../src/studio/server/dev-port.js'

describe('resolveDevApiPort：env 单源与缺省', () => {
  it('未设 env → 缺省 7878（与 Vite 代理目标一致）', () => {
    expect(DEV_API_PORT_ENV).toBe('CLW_DEV_API_PORT')
    expect(resolveDevApiPort({})).toBe(DEV_API_DEFAULT_PORT)
    expect(DEV_API_DEFAULT_PORT).toBe(7878)
  })

  it('合法 1–65535 整数透传（含边界值与首尾空白容忍——R39-9 同口径）', () => {
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '8081' })).toBe(8081)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '1' })).toBe(1)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: '65535' })).toBe(65535)
    expect(resolveDevApiPort({ [DEV_API_PORT_ENV]: ' 7878 ' })).toBe(7878) // 首尾空白容忍（R39-9 同口径）
  })
})

describe("resolveDevApiPort：'0' 拒绝（dev 链路防静默失联）", () => {
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
    // 终止（真 exit 不返回；若 stub 平返回，函数会穿透到 `return n` 失真）。
    // nano-13（四轮处置批）：直写赋值改 vi.spyOn——直写绕开 vitest 桩管理，恢复
    // 依赖手工对称还原；spy 的 mockRestore 单点收口（断言中途抛错也走 finally）。
    const exits: Array<number | string | undefined> = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number | string | undefined) => {
        exits.push(code)
        throw new Error('EXIT_SENTINEL')
      }) as never)
    try {
      expect(() => resolveDevApiPort({ [DEV_API_PORT_ENV]: '0' })).toThrow('EXIT_SENTINEL')
      expect(exits).toEqual([2])
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

describe('resolveDevApiPort：非法值 fatal 通道', () => {
  it('非法值 → fatal 人话消息点名 env 名，回落缺省（注入 fatal 不真退进程）', () => {
    const fatals: string[] = []
    const fatal = (msg: string): void => {
      fatals.push(msg)
    }
    // R55-E-3：'0' 从合法集移入非法集——0 → listen 随机端口，与固定 7878 的 Vite
    // 代理静默失联（详见 src/studio/server/dev-port.ts 内注）
    for (const bad of ['abc', '', '-1', '0', '65536', '80.5']) {
      fatals.length = 0
      const port = resolveDevApiPort({ [DEV_API_PORT_ENV]: bad }, { fatal })
      expect(port).toBe(DEV_API_DEFAULT_PORT)
      expect(fatals).toHaveLength(1)
      expect(fatals[0]).toContain(DEV_API_PORT_ENV)
      expect(fatals[0]).toContain(bad)
    }
  })
})
