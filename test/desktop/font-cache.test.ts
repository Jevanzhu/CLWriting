/**
 * R77-1（二十五轮批 A）：系统字体 TTL 缓存单测——
 * ① 命中期零重跑（loader 一次）；② TTL 过期重探；③ 并发在途合并（双 get 单 loader）；
 * ④ 失败不缓存（负缓存禁止，两次失败两次真跑）；⑤ 成功空数组照缓存（合法结果面）。
 * now 注入假时钟，测试零真实等待。
 */
import { describe, expect, it } from 'vitest'
import { createSystemFontCache } from '../../src/desktop/font-cache.js'

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
