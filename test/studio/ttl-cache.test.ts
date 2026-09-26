/**
 * D1（复审-0914-优化修复批）：ttl-cache.ts 通用件单测——server 域 17 份 TTL+探针+FIFO
 * 缓存壳收敛后的共享壳六面回归（命中 / TTL 过期 / probe 失效 / FIFO 逐出 / 续命语义 /
 * forget），另覆盖两级探针节流、in-flight 去重、storeIf 只缓存成功、写侧全表清扫四个
 * 收敛变体。时序断言用 vi.setSystemTime 控钟（生产件直读 Date.now），不依赖真实墙钟。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTtlProbeCache } from '../../src/studio/server/ttl-cache.js'

let now = 1_000_000

function advance(ms: number): void {
  now += ms
  vi.setSystemTime(now)
}

beforeEach(() => {
  vi.useFakeTimers()
  now = 1_000_000
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.useRealTimers()
})

/** 标准单级探针壳：指纹可由用例改写（模拟目录结构变化），计算体计数暴露。 */
function makeProbeCache(opts?: { ttl?: number; max?: number }) {
  const calls: string[] = []
  let sig = 's1'
  const cache = createTtlProbeCache<string, string>({
    name: 'probe-test',
    keyOf: (k) => k,
    max: opts?.max ?? 4,
    ttl: () => opts?.ttl ?? 100,
    probe: () => sig,
    computeSync: (key) => {
      calls.push(`sync:${key}`)
      return key
    },
  })
  return { cache, calls, setSig: (s: string) => (sig = s) }
}

describe('ttl-cache 六面', () => {
  it('命中：probe 未变且未过 TTL → 返回缓存值且不重算（命中前 probe 照付——扫描前取值口径）', () => {
    const { cache, calls } = makeProbeCache()
    expect(cache.getSync('a')).toBe('a')
    expect(cache.getSync('a')).toBe('a')
    expect(calls).toEqual(['sync:a']) // 只算一次
  })

  it('TTL 过期：超窗后重算；过期条目顺手逐出（evictExpiredOnMiss=true 缺省）', () => {
    const { cache, calls } = makeProbeCache()
    cache.getSync('a')
    advance(100) // now - ts == ttl → 过期（判定式为 `<`）
    expect(cache.getSync('a')).toBe('a')
    expect(calls).toEqual(['sync:a', 'sync:a']) // 过期重算
    expect(cache.has('a')).toBe(true) // set 原键覆写
  })

  it('TTL 过期：evictExpiredOnMiss=false 时过期死条目不被顺手逐出（settings×2 / overview state 原样特例）', () => {
    let fail = false
    const cache = createTtlProbeCache<string, string>({
      name: 'probe-test-noevict',
      keyOf: (k) => k,
      max: 4,
      ttl: () => 100,
      probe: () => 's1',
      computeSync: () => {
        if (fail) throw new Error('boom')
        return 'ok'
      },
      evictExpiredOnMiss: false,
    })
    cache.getSync('a') // 落一条成功条目
    advance(100) // 过期
    fail = true
    expect(() => cache.getSync('a')).toThrow('boom') // 重算失败不落缓存
    expect(cache.has('a')).toBe(true) // 过期死条目驻留（对照「有逐出」形态 = ttl-evict-on-expiry 回归）
  })

  it('probe 失效：TTL 窗内指纹变化即重算（probe 未变 && 未过 TTL 才命中）', () => {
    const { cache, calls, setSig } = makeProbeCache()
    cache.getSync('a')
    advance(10)
    setSig('s2')
    expect(cache.getSync('a')).toBe('a')
    expect(calls).toEqual(['sync:a', 'sync:a']) // 指纹失配 → 重算
  })

  it('FIFO 逐出：超 max 丢最旧（Map 插入序）；命中不续命（插入了 A,B,C 后 hit A 再插 D → 逐出 A）', () => {
    const { cache, calls } = makeProbeCache({ max: 3 })
    cache.getSync('a')
    advance(1)
    cache.getSync('b')
    advance(1)
    cache.getSync('c')
    advance(1)
    expect(cache.getSync('a')).toBe('a') // 命中（不重排、不续命）
    expect(calls).toEqual(['sync:a', 'sync:b', 'sync:c'])
    advance(1)
    cache.getSync('d') // size 3 → 触顶逐最旧 a（命中未改变插入序）
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
  })

  it('续命语义：命中不刷新 ts——TTL 窗不因命中延长（到点即失效）', () => {
    const { cache, calls } = makeProbeCache({ ttl: 100 })
    cache.getSync('a')
    advance(60)
    expect(cache.getSync('a')).toBe('a') // 命中（不计入 scan）
    advance(60) // 距写入 120 > 100：命中不续命 → 已过期
    expect(cache.getSync('a')).toBe('a')
    expect(calls).toEqual(['sync:a', 'sync:a']) // 第 2 次调用 = 命中；第 3 次 = 过期重算
  })

  it('forget 面：forget 精确键删 / forgetPrefix 复合键前缀删 / clear 整表清 / has 观测', () => {
    const keyed = createTtlProbeCache<{ root: string; q: string }, string>({
      name: 'forget-test',
      keyOf: (k) => `${k.root}\u0000${k.q}`,
      max: 8,
      ttl: () => 100,
      computeSync: () => 'v',
    })
    keyed.getSync({ root: '/books/a', q: 'x' })
    keyed.getSync({ root: '/books/a', q: 'y' })
    keyed.getSync({ root: '/books/b', q: 'x' })
    keyed.forgetPrefix('/books/a') // 存储键 startsWith('/books/a\0')
    expect(keyed.has({ root: '/books/a', q: 'x' })).toBe(false)
    expect(keyed.has({ root: '/books/a', q: 'y' })).toBe(false)
    expect(keyed.has({ root: '/books/b', q: 'x' })).toBe(true)
    keyed.forget({ root: '/books/b', q: 'x' })
    expect(keyed.has({ root: '/books/b', q: 'x' })).toBe(false)
    keyed.getSync({ root: '/books/b', q: 'x' })
    keyed.clear()
    expect(keyed.has({ root: '/books/b', q: 'x' })).toBe(false)
  })
})

describe('ttl-cache 收敛变体', () => {
  it('两级探针：TTL 窗内一级指纹节流复用（probe 不重付）；指纹变化走二级签名，签名一致回填指纹免重算', async () => {
    let l1 = 'd1'
    let full = 'f1'
    let probeRuns = 0
    let sigRuns = 0
    let computeRuns = 0
    const cache = createTtlProbeCache<string, string>({
      name: 'two-level',
      keyOf: (k) => k,
      max: 4,
      ttl: () => 100,
      probe: () => {
        probeRuns += 1
        return l1
      },
      signature: () => {
        sigRuns += 1
        return full
      },
      computeAsync: () => {
        computeRuns += 1
        advance(50) // 计算体耗时 50ms → ts = probeTs + 50（两窗分离，L2 复用窗可达）
        return Promise.resolve('v')
      },
    })
    await cache.get('a') // 冷启动：probe + 二级签名 + 重算各一次（compute 耗时 50 → ts=T0+50，probeTs=T0）
    expect(probeRuns).toBe(1)
    expect(sigRuns).toBe(1)
    expect(computeRuns).toBe(1)
    l1 = 'd2' // 一级指纹变（模拟原子写抖动）
    advance(60) // t=T0+110：探针窗过（110 ≥ 100）→ 重探见新指纹；缓存 TTL 未过（60 < 100），
    await cache.get('a') // 全量签名一致 → 回填指纹复用免重算（R44-9① L2 复用正本语义）
    expect(probeRuns).toBe(2)
    expect(sigRuns).toBe(2)
    expect(computeRuns).toBe(1)
    advance(40) // t=T0+150：探针窗内复用（40 < 100）不重付；缓存 TTL 已过（100 ≥ 100）→
    l1 = 'd3' // 探针虽新鲜仍判过期：逐出 + 真重算（命中不续命，ts 未被复用刷新）
    full = 'f2'
    await cache.get('a')
    expect(probeRuns).toBe(2)
    expect(sigRuns).toBe(3)
    expect(computeRuns).toBe(2)
  })

  it('in-flight 去重：同键并发 MISS 合并为一次计算；不同键各算各的', async () => {
    let computeRuns = 0
    const cache = createTtlProbeCache<string, string>({
      name: 'inflight-test',
      keyOf: (k) => k,
      max: 4,
      ttl: () => 100,
      computeAsync: (key) => {
        computeRuns += 1
        return Promise.resolve(key)
      },
      inFlight: true,
    })
    const [x, y, z] = await Promise.all([cache.get('k'), cache.get('k'), cache.get('j')])
    expect(x).toBe('k')
    expect(y).toBe('k')
    expect(z).toBe('j')
    expect(computeRuns).toBe(2)
  })

  it('storeIf：不满足条件返回值但不落缓存（失败不占 FIFO 位）', () => {
    let ok = false
    const cache = createTtlProbeCache<string, { ok: boolean }>({
      name: 'storeif-test',
      keyOf: (k) => k,
      max: 4,
      ttl: () => 100,
      computeSync: () => ({ ok }),
      storeIf: (v) => v.ok,
    })
    expect(cache.getSync('a').ok).toBe(false)
    expect(cache.has('a')).toBe(false) // 失败不落缓存
    ok = true
    expect(cache.getSync('a').ok).toBe(true)
    expect(cache.has('a')).toBe(true)
  })

  it('sweepExpiredOnWrite：写路径顺带清全表过期条目（styleCorpus R58-B-10 口径）', () => {
    const cache = createTtlProbeCache<string, string>({
      name: 'sweep-test',
      keyOf: (k) => k,
      max: 8,
      ttl: () => 100,
      computeSync: (k) => k,
      sweepExpiredOnWrite: true,
    })
    cache.getSync('old')
    advance(150) // old 过期
    cache.getSync('fresh') // MISS 计算成功 → 写路径清扫 old
    expect(cache.has('old')).toBe(false)
    expect(cache.has('fresh')).toBe(true)
  })

  it('stats：MISS→实际计算计数，命中不增（原 scanCountForTest；R0916-7-P3-6 收编进观测面）', () => {
    const { cache, calls } = makeProbeCache()
    cache.getSync('a')
    cache.getSync('a')
    advance(100)
    cache.getSync('a')
    expect(cache.stats().misses).toBe(2)
    expect(calls.length).toBe(2)
    cache.resetStats()
    expect(cache.stats().misses).toBe(0)
  })
})
