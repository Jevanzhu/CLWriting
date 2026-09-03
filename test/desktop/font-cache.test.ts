/**
 * R77-1（二十五轮批 A）：系统字体 TTL 缓存单测——
 * ① 命中期零重跑（loader 一次）；② TTL 过期重探；③ 并发在途合并（双 get 单 loader）；
 * ④ 失败不缓存（负缓存禁止，两次失败两次真跑）；⑤ 成功空数组照缓存（合法结果面）。
 * now 注入假时钟，测试零真实等待。
 */
import { describe, expect, it } from 'vitest'
import {
  createSystemFontCache,
  fontListWithTimeout,
  FONT_LIST_TIMEOUT_MS,
  __setFontListTimeoutForTest,
} from '../../src/desktop/font-cache.js'

describe('createSystemFontCache（R77-1 批 A）', () => {
  it('TTL 内命中缓存：两次调用 loader 只跑一次', async () => {
    let t = 1000
    let calls = 0
    const get = createSystemFontCache(
      async () => {
        calls++
        return ['PingFang SC']
      },
      { now: () => t },
    )
    await expect(get()).resolves.toEqual(['PingFang SC'])
    t += 59_999
    await expect(get()).resolves.toEqual(['PingFang SC'])
    expect(calls).toBe(1)
  })

  it('TTL 过期重探：新结果覆盖旧缓存', async () => {
    let t = 1000
    let n = 0
    const get = createSystemFontCache(
      async () => {
        n++
        return [`font-${n}`]
      },
      { ttlMs: 60_000, now: () => t },
    )
    await expect(get()).resolves.toEqual(['font-1'])
    t += 60_001
    await expect(get()).resolves.toEqual(['font-2'])
  })

  it('并发在途合并：未决期两次 get 同一结果，loader 只跑一次', async () => {
    let calls = 0
    let resolveLoad: (v: string[]) => void = () => {}
    const get = createSystemFontCache(
      () =>
        new Promise<string[]>((res) => {
          calls++
          resolveLoad = res
        }),
    )
    const p1 = get()
    const p2 = get()
    resolveLoad(['LXGW WenKai'])
    await expect(p1).resolves.toEqual(['LXGW WenKai'])
    await expect(p2).resolves.toEqual(['LXGW WenKai'])
    expect(calls).toBe(1)
  })

  it('失败不缓存：两次失败都抛、loader 各跑一次', async () => {
    let calls = 0
    const get = createSystemFontCache(async () => {
      calls++
      throw new Error('系统命令失败')
    })
    await expect(get()).rejects.toThrow('系统命令失败')
    await expect(get()).rejects.toThrow('系统命令失败')
    expect(calls).toBe(2)
  })

  it('成功空数组照缓存（合法结果，不重复探测）', async () => {
    let calls = 0
    const get = createSystemFontCache(async () => {
      calls++
      return []
    })
    await expect(get()).resolves.toEqual([])
    await expect(get()).resolves.toEqual([])
    expect(calls).toBe(1)
  })
})

// R40-28（四十轮）：mac/linux font-list 超时包裹——osascript/系统命令挂起时 Promise
// 永不结算（字体下拉悬死）；超时 reject（font-list 不暴露子进程句柄，不 kill）；
// 晚到结算吞掉不成 unhandledRejection；快路径 clearTimeout 正常 resolve / 错误透传。
describe('R40-28：fontListWithTimeout（font-list 超时包裹）', () => {
  it('hang 的 loader：超时 reject（注入缩短超时，文案含档位）', async () => {
    __setFontListTimeoutForTest(20)
    try {
      await expect(
        fontListWithTimeout(() => new Promise<string[]>(() => {})), // 永不结算（osascript 挂起形态）
      ).rejects.toThrow('font-list 字体枚举超过 20ms 未返回')
    } finally {
      __setFontListTimeoutForTest(FONT_LIST_TIMEOUT_MS) // 还原档位，不外溢后续用例
    }
  })

  it('快路径：超时前返回正常 resolve；loader 错误原样透传', async () => {
    __setFontListTimeoutForTest(5_000)
    try {
      await expect(fontListWithTimeout(async () => ['PingFang SC'])).resolves.toEqual(['PingFang SC'])
      await expect(
        fontListWithTimeout(async () => {
          throw new Error('系统命令失败')
        }),
      ).rejects.toThrow('系统命令失败')
    } finally {
      __setFontListTimeoutForTest(FONT_LIST_TIMEOUT_MS)
    }
  })

  it('超时后 loader 晚到 reject 不成 unhandledRejection（已接住）', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    let lateReject!: (e: Error) => void
    __setFontListTimeoutForTest(10)
    try {
      const p = fontListWithTimeout(
        () =>
          new Promise<string[]>((_res, rej) => {
            lateReject = rej
          }),
      )
      await expect(p).rejects.toThrow('font-list 字体枚举超过 10ms')
      lateReject(new Error('晚到的 osascript 失败'))
      await new Promise((r) => setTimeout(r, 30)) // 让晚到 rejection 有落地窗口
      expect(unhandled).toEqual([])
    } finally {
      __setFontListTimeoutForTest(FONT_LIST_TIMEOUT_MS)
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
