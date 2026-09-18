/**
 * 0918二轮修复批（C107）：重复信号硬退出口单元测试——src/desktop/signal-hard-exit.ts
 * 响应逻辑（同型信号第二次 killNow + exit(1) 硬退；首次走 app.quit 优雅链单次语义
 * 不变；异型信号不互触发）。main.ts 接线（process.on 三行）的进程内集成形态见
 * main-lifecycle-exit.test.ts 同批用例。
 */
import { describe, it, expect, vi } from 'vitest'
import { createRepeatedSignalExit } from '../../src/desktop/signal-hard-exit.js'

describe('createRepeatedSignalExit：重复信号硬退出口（C107）', () => {
  function mkDeps() {
    const order: string[] = []
    return {
      order,
      deps: {
        requestGracefulQuit: (): void => {
          order.push('quit')
        },
        killNow: (): void => {
          order.push('kill')
        },
        exit: (code: number): void => {
          order.push(`exit:${code}`)
        },
      },
    }
  }

  it('首次信号 → 优雅退出一次，不硬退（单次优雅链语义不变）', () => {
    const { order, deps } = mkDeps()
    const h = createRepeatedSignalExit(deps)
    h('SIGINT')
    expect(order).toEqual(['quit'])
  })

  it('同型信号第二次 → killNow 先行 + exit(1) 硬退（先 kill 再退，防 utilityProcess 孤儿）+ 留痕', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { order, deps } = mkDeps()
      const h = createRepeatedSignalExit(deps)
      h('SIGINT')
      h('SIGINT') // 优雅链在途（最坏 ~10s）内二次 Ctrl+C
      expect(order).toEqual(['quit', 'kill', 'exit:1'])
      // 留痕：log.error 未 initLogging 时镜像 console.error（真实日志通道）
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('SIGINT'))).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })

  it('异型信号不互触发：SIGINT 后 SIGTERM 仍各走优雅链，SIGTERM 自身第二次才硬退', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { order, deps } = mkDeps()
      const h = createRepeatedSignalExit(deps)
      h('SIGINT')
      h('SIGTERM') // 异型 ≠ 重复：app.quit 幂等无害
      expect(order).toEqual(['quit', 'quit'])
      expect(errSpy).not.toHaveBeenCalled()
      h('SIGTERM') // SIGTERM 的第二次
      expect(order).toEqual(['quit', 'quit', 'kill', 'exit:1'])
    } finally {
      errSpy.mockRestore()
    }
  })
})
