/**
 * shelf store 单测（第十一轮 P1-TST-1）：
 * 书架列表加载 / workDir 缺失提示 / 错误处理。
 *
 * win 平台专项（2026-09-02）：书架快照缓存——冷启动/刷新时 store 全新起始，
 * 起始同步灌入上次成功拉取的快照再后台刷新，列表「加载中…」不再卡整屏。
 * 二审改 localStorage：sessionStorage 关窗即清，冷启动（dev app 重开）读不到没效果。
 * node 环境默认无 localStorage（typeof 未定义 → 缓存路径退化），此处用注入的
 * globalThis.localStorage 桩显式断言缓存语义。
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../src/studio/web-next/src/api/shelf', () => ({
  listBooks: vi.fn(),
}))

import { listBooks } from '../../../src/studio/web-next/src/api/shelf'
import { useShelfStore } from '../../../src/studio/web-next/src/stores/shelf'

const listMock = listBooks as ReturnType<typeof vi.fn>

const CACHE_KEY = 'clw.shelf.cache.v1'

/** 注入 localStorage 桩（node 环境无 window/localStorage）——模拟跨窗口/冷启动快照 */
function stubLocalStorage(initial: Record<string, string> = {}): { storage: Map<string, string> } {
  const storage = new Map<string, string>(Object.entries(initial))
  const ss = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
    clear: () => storage.clear(),
  }
  vi.stubGlobal('localStorage', ss)
  return { storage }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // happy-dom 提供真实的、跨测试文件内持久化的全局 localStorage——测试 #1 成功拉取会
  // 把快照写入它，污染后续「无快照」用例（读到残留缓存）。每例起始清空，消除上下文泄漏。
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.clear()
    } catch {
      /* 忽略 */
    }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shelf: 加载书架', () => {
  it('load 成功 → books 填充 + workDirMissing false', async () => {
    listMock.mockResolvedValue({
      books: [{ name: '长篇1', kind: 'long' }, { name: '短篇集1', kind: 'short' }],
      workDir: true,
    })
    const s = useShelfStore()
    await s.load()
    expect(s.books).toHaveLength(2)
    expect(s.workDirMissing).toBe(false)
    expect(s.hint).toBeNull()
    expect(s.loading).toBe(false)
    expect(s.error).toBeNull()
  })

  it('load 无 workDir → workDirMissing true + hint', async () => {
    listMock.mockResolvedValue({
      books: [],
      workDir: false,
      hint: '请先选择书库目录',
    })
    const s = useShelfStore()
    await s.load()
    expect(s.books).toHaveLength(0)
    expect(s.workDirMissing).toBe(true)
    expect(s.hint).toBe('请先选择书库目录')
  })

  it('load 失败 → error 设置', async () => {
    listMock.mockRejectedValue(new Error('网络断开'))
    const s = useShelfStore()
    await s.load()
    expect(s.error).not.toBeNull()
    expect(s.loading).toBe(false)
  })

  // N-12（第五十四轮）：并发两次 load，先发的慢响应迟到不回填——后发者生效
  it('N-12: 并发两次 load → 后发者生效（慢响应迟到不回填旧数据）', async () => {
    let resolveSlow!: (v: { books: { name: string; kind: string }[]; workDir: boolean; hint?: string }) => void
    listMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveSlow = r
        }),
    )
    listMock.mockResolvedValueOnce({ books: [{ name: '新书', kind: 'long' }], workDir: true })
    const s = useShelfStore()
    const p1 = s.load()
    const p2 = s.load() // 后发：先返回
    resolveSlow({ books: [{ name: '旧书', kind: 'long' }], workDir: true }) // 先发的慢响应迟到
    await Promise.all([p1, p2])
    expect(s.books.map((b) => b.name)).toEqual(['新书'])
    expect(s.loading).toBe(false)
  })

  // win 平台专项（2026-09-02）：localStorage 快照缓存
  describe('书架快照缓存（win 平台专项）', () => {
    it('有快照：load 起始同步灌入 → loading 保持 false（列表立即渲染）', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({
          books: [{ name: '缓存书', kind: 'long', words: 100 }],
          workDirMissing: false,
          hint: null,
        }),
      })
      // 慢响应：有快照时不显示 loading，后台拉最新
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      // 同步灌入已发生（await 前 books 已就位）
      expect(s.books.map((b) => b.name)).toEqual(['缓存书'])
      expect(s.loading).toBe(false)
      resolveSlow({ books: [{ name: '最新书', kind: 'long' }], workDir: true })
      await p
      expect(s.books.map((b) => b.name)).toEqual(['最新书'])
      expect(s.loading).toBe(false)
    })

    it('有快照且刷新失败：沿用缓存 + console.warn 留痕，不整屏报错', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({
          books: [{ name: '缓存书', kind: 'long' }],
          workDirMissing: false,
          hint: null,
        }),
      })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      listMock.mockRejectedValue(new Error('网络断开'))
      const s = useShelfStore()
      await s.load()
      expect(s.books.map((b) => b.name)).toEqual(['缓存书'])
      expect(s.loading).toBe(false)
      expect(s.error).toBeNull() // 有快照：不整屏报错
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('成功拉取后写入快照（下次刷新可复用）', async () => {
      const { storage } = stubLocalStorage()
      listMock.mockResolvedValue({
        books: [{ name: '书A', kind: 'long', words: 5 }],
        workDir: true,
      })
      const s = useShelfStore()
      await s.load()
      const cached = JSON.parse(storage.get(CACHE_KEY)!) as { books: { name: string }[]; workDirMissing: boolean }
      expect(cached.books.map((b) => b.name)).toEqual(['书A'])
      expect(cached.workDirMissing).toBe(false)
    })

    it('无快照（首屏）：维持原「加载中…」语义', async () => {
      // 默认不注 localStorage → readCache 退化 null
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      expect(s.loading).toBe(true) // 无快照：loading 起
      resolveSlow({ books: [{ name: '新书', kind: 'long' }], workDir: true })
      await p
      expect(s.loading).toBe(false)
      expect(s.books.map((b) => b.name)).toEqual(['新书'])
    })

    it('无快照且失败：照旧上抛 error（与原有行为一致）', async () => {
      listMock.mockRejectedValue(new Error('网络断开'))
      const s = useShelfStore()
      await s.load()
      expect(s.error).not.toBeNull()
      expect(s.loading).toBe(false)
    })

    // R50-D2-3（五十轮）：readCache 逐条校验——坏条目（null/数字/缺 name/title 非
    // string）在消费点 (b.title ?? b.name).toLowerCase() 抛 TypeError 整页白屏；
    // 修后逐条丢弃、好条目保留（全坏 → 空表，有快照路径立即渲染空列表再后台刷新）。
    it('R50-D2-3: 快照含坏条目 → 逐条丢弃好条目保留，消费点口径 filter+toLowerCase 不抛', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({
          books: [
            { name: '好书', kind: 'long' },
            null,
            42,
            '坏字符串元素',
            { title: '只有title缺name' },
            { name: 123 },
            { name: 'title非字符串', title: 7 },
          ],
          workDirMissing: false,
          hint: null,
        }),
      })
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      // 灌入仅含合法条目（坏条目全部丢弃），白屏消费点（useShelf filteredBooks 口径）安全执行
      expect(s.books.map((b) => b.title ?? b.name)).toEqual(['好书'])
      expect(s.books.filter((b) => (b.title ?? b.name).toLowerCase().includes('好'))).toHaveLength(1)
      expect(s.loading).toBe(false) // 有快照路径：不卡「加载中…」
      resolveSlow({ books: [{ name: '最新书', kind: 'long' }], workDir: true })
      await p
      expect(s.books.map((b) => b.name)).toEqual(['最新书']) // 后台刷新照常覆盖
    })

    it('R50-D2-3: 快照全坏条目 → 空表缓存（非 null），书架走有快照路径渲染空列表不白屏', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({ books: [null, 42, 'x'], workDirMissing: false, hint: null }),
      })
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      expect(s.books).toEqual([]) // 全坏 → 空表（好于白屏；后台刷新拉权威列表）
      expect(s.loading).toBe(false)
      resolveSlow({ books: [{ name: '最新书', kind: 'long' }], workDir: true })
      await p
      expect(s.books.map((b) => b.name)).toEqual(['最新书'])
    })

    // 重评-P3-13（2026-09-09 全量代码重评）：workDirMissing/hint 与 books 同口径形状校验
    it('重评-P3-13: 快照 hint 为对象/workDirMissing 非布尔 → 回落缺省值（books 合法条目照常灌入）', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({
          books: [{ name: '缓存书', kind: 'long' }],
          workDirMissing: 'yes',
          hint: { text: '坏形状' },
        }),
      })
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      expect(s.books.map((b) => b.name)).toEqual(['缓存书']) // books 校验通过照常灌入
      expect(s.workDirMissing).toBe(false) // 非 boolean → 缺省 false
      expect(s.hint).toBeNull() // 非 string → 缺省 null
      resolveSlow({ books: [{ name: '最新书', kind: 'long' }], workDir: true })
      await p
      expect(s.books.map((b) => b.name)).toEqual(['最新书']) // 后台刷新照常覆盖
    })

    it('重评-P3-13: 快照 hint 为数字/workDirMissing 非布尔 → 同款回落缺省，后台刷新以权威数据覆盖', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({
          books: [{ name: '缓存书', kind: 'long' }],
          workDirMissing: 0,
          hint: 42,
        }),
      })
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      expect(s.workDirMissing).toBe(false)
      expect(s.hint).toBeNull()
      resolveSlow({ books: [], workDir: false, hint: '请先选择书库目录' })
      await p
      expect(s.workDirMissing).toBe(true)
      expect(s.hint).toBe('请先选择书库目录')
    })

    it('重评-P3-13 对照: 合法快照值（boolean workDirMissing / string hint）照常直通不被误拦', async () => {
      stubLocalStorage({
        [CACHE_KEY]: JSON.stringify({
          books: [{ name: '缓存书', kind: 'long' }],
          workDirMissing: true,
          hint: '请先选择书库目录',
        }),
      })
      let resolveSlow!: (v: unknown) => void
      listMock.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSlow = r
          }),
      )
      const s = useShelfStore()
      const p = s.load()
      expect(s.workDirMissing).toBe(true)
      expect(s.hint).toBe('请先选择书库目录')
      resolveSlow({ books: [{ name: '最新书', kind: 'long' }], workDir: true })
      await p
    })
  })
})
