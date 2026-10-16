/**
 * D1（复审-0914-优化修复批）：ttl-cache.ts 通用件单测——server 域 17 份 TTL+探针+FIFO
 * 缓存壳收敛后的共享壳六面回归（命中 / TTL 过期 / probe 失效 / FIFO 逐出 / 续命语义 /
 * forget），另覆盖两级探针节流、in-flight 去重、storeIf 只缓存成功、写侧全表清扫四个
 * 收敛变体。时序断言用 vi.setSystemTime 控钟（生产件直读 Date.now），不依赖真实墙钟。
 *
 * 另承载**书键缓存登记制机器门**（登记制改版）：src/** 全部缓存失效族导出
 *（forget* / invalidate* / clear*）与 cache-registry 登记表运行时实际登记项双向对账
 *（漏登记 / 登记死项 / 僵尸豁免均红）——登记完整性不靠人记；详见文末 describe 头注。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTtlProbeCache } from '../../../src/studio/server/ttl-cache.js'
import { listBookKeyedCaches } from '../../../src/studio/server/cache-registry.js'
import '../../../src/studio/server/api/books-lifecycle.js' // 聚合入口（side-effect：触发全部书键缓存自登记）

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

// ── 书键缓存登记制机器门 ────────────────────────────────────────────────────
// 背景：书键缓存的删/改名失效此前靠 forgetBookKeyedCaches 里的手工清单（22 条），
// 新增书级缓存漏加一行即跨书陈旧数据串味（同名重建书读旧书结果），无编译期/运行时
// 兜底。登记制改版后：各缓存模块顶层自登记（registerBookKeyedCache），本门即
// 「登记完整性不靠人记」的机器兜底。
//
// 口径（比评审原文更紧——不只首参 bookRoot，缓存失效族的全部导出都必须落到登记表或
// 逐项豁免，防「改参数名逃逸」）：
// - 扫描 src/** 全部 `export function (forget|invalidate|clear)*` /
//   `export const (forget|invalidate|clear)*`（行首锚定，JSDoc 行以 ' *' 起头不会误捕）；
//   同义族同等对待——只认 forget* 时，一个书键缓存是否入门只看作者给它的失效函数起
//   什么名（invalidateBookSummary / clearChapterDirCacheForBook 一类即落在观测盲区）；
// - 正向：每个扫描项必须已登记（按函数名对账）或在下方 EXEMPT 逐项豁免（含理由；
//   禁目录级豁免——豁免清单自身过僵尸检查）；
// - 反向：登记表每项须来自真实源码（forgetFn.name 非空者必须命中扫描集），
//   匿名登记（shelf-guard 整表清扫闭包）豁免函数名反查。
// 扫描面 = src/studio/server/cache-registry.ts + 聚合入口 side-effect import 的求值链。

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC = join(ROOT, 'src')

interface InvalidatorExport {
  /** 仓库相对路径（正斜杠） */
  rel: string
  fn: string
  /** 首参名（无参 / 解构首参时 undefined） */
  firstParam: string | undefined
}

/** src 下全部 .ts（排除 .d.ts / node_modules / macOS ._ 垃圾）——口径同 governance 门。 */
function listSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('._') || name === 'node_modules') continue
    const fp = join(dir, name)
    if (statSync(fp).isDirectory()) listSources(fp, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(fp)
  }
  return out
}

/** 单份 .ts 正文里的缓存失效族导出（函数声明 + const 箭头两形态）——纯函数，门自身用例直测。 */
function matchInvalidatorExports(text: string, rel: string): InvalidatorExport[] {
  const found: InvalidatorExport[] = []
  const fnRe = /^[ \t]*export\s+(?:async\s+)?function\s+((?:forget|invalidate|clear)\w+)\s*(?:<[^(]*>)?\s*\(([^)]*)\)/gm
  const constRe = /^[ \t]*export\s+const\s+((?:forget|invalidate|clear)\w+)\s*[:=]/gm
  for (const m of text.matchAll(fnRe)) {
    const pm = /^([A-Za-z_$][\w$]*)/.exec((m[2] ?? '').trim())
    found.push({ rel, fn: m[1]!, firstParam: pm ? pm[1] : undefined })
  }
  for (const m of text.matchAll(constRe)) {
    found.push({ rel, fn: m[1]!, firstParam: undefined })
  }
  return found
}

/** 扫描 src/** 的 forget/invalidate/clear 族导出（口径见文末 describe 头注）。 */
function scanInvalidatorExports(): InvalidatorExport[] {
  const found: InvalidatorExport[] = []
  for (const fp of listSources(SRC)) {
    const rel = relative(ROOT, fp).split('\\').join('/')
    found.push(...matchInvalidatorExports(readFileSync(fp, 'utf-8'), rel))
  }
  return found
}

/** 逐项豁免（禁目录级；键 = `仓库相对路径::函数名`）。每条豁免即一条认账。
 *  豁免判据（须命中其一）：非「进程内书键结果缓存」的失效面——进程全局缓存 / 按书名单键 /
 *  文件态记录与状态 / 需额外上下文（db 句柄、relPath、structural 形态、userDataPath）/
 *  测试专用导出（零生产调用）/ 前端树（web-next 浏览器侧）。 */
const EXEMPT_CACHE_INVALIDATORS: ReadonlyArray<{ key: string; why: string }> = [
  {
    key: 'src/studio/server/cache-registry.ts::forgetBookKeyedCaches',
    why: '广播本体（登记表遍历）——失效编排入口，非缓存失效项',
  },
  {
    key: 'src/studio/server/api/books-lifecycle.ts::forgetBookKeyedCaches',
    why: '广播本体的调用面转发壳（历史导出位；books.ts / books-rename.ts 经此 import）',
  },
  {
    key: 'src/document/foreshadow.ts::forgetChapterTextCacheForBook',
    why: '纯委托包装——缓存单源 fs/md-text-cache.ts（forgetMdTextCacheForBook 已自登记），重复登记 = 同表二次清扫',
  },
  {
    key: 'src/driver/index.ts::forgetSession',
    why: '驱动实例会话缓存按书名（bookId）键控，非 bookRoot 键族；删/改名路由行内直调',
  },
  {
    key: 'src/studio/server/api/documents-core.ts::forgetService',
    why: 'DocumentService 实例缓存——失效挂点在删/改名路由行内直调，不在 22 条广播内（纳入会改调用面）',
  },
  {
    key: 'src/studio/server/api/rag.ts::forgetRagBuildTask',
    why: '模块级索引任务表按书名（bookName）键控，非 bookRoot 键族；删/改名路由行内直调',
  },
  {
    key: 'src/studio/server/api/stream-sse-writer.ts::forgetSseCount',
    why: 'per-book SSE 连接计数按书名（bookName）键控，非 bookRoot 键族；删/改名路由行内直调',
  },
  // ── invalidate 族（同义族扩面后新入场，逐项复核结论）──────────────────────
  {
    key: 'src/document/tree.ts::invalidateTreeIndex',
    why: '结构性变更失效 API——第二参 structural 决定是否连带清磁盘树红点表（invalidateTreeIndex(true) 形态），finalize/trash/move/merge/split 等 document 层 mutation 共用；非「按书清本缓存」的纯失效器，登记表单参调用面表达不了该契约（删/改名行内直调携带 structural=true）',
  },
  {
    key: 'src/document/tree.ts::invalidateTreeIndexForContent',
    why: '内容保存的单键失效——第二参 relPath 必需（整书清由 invalidateTreeIndex 承担），登记表单参形态表达不了',
  },
  // ── clear 族 ─────────────────────────────────────────────────────────────
  {
    key: 'src/check/tree-issues-cache.ts::clearTreeIssuesCacheForBook',
    why: '磁盘表（<bookRoot>/.cache/index.db，键为 rel_path）整表清——表随书目录同生共死：删书随目录入墓地、改名随目录平移（rel_path 键跨改名仍有效），删/改名时旧路径已不存在，清理恒为 no-op；到达面是 document/tree.ts 的 invalidateTreeIndex(structural=true)',
  },
  {
    key: 'src/format/chapters.ts::clearChapterDirCache',
    why: '测试专用导出（零生产调用）且无参全局清（全清会误伤他书活跃条目——按书清走 clearChapterDirCacheForBook，后者已自登记）',
  },
  {
    key: 'src/ai/orchestrate/chat/state.ts::clearChatHistory',
    why: '对话历史清理（内存 Map + 事件库行），非结果缓存；按书名键控且删/改名路由行内 await 直调（含事件库半完成态降级口径）',
  },
  {
    key: 'src/ai/provider/registry.ts::clearProviderCache',
    why: '测试专用导出（零生产调用）——provider 实例缓存按 conf hash 键控（非书键），生产侧失效由键自然完成',
  },
  {
    key: 'src/cache/schema.ts::clearAllTables',
    why: '需 DatabaseSync 句柄的清表原语（缓存库全量重建前调用），键面为表名而非书键',
  },
  {
    key: 'src/events/store-open.ts::clearStaleMigrationTombstone',
    why: '事件库迁移墓碑（文件态标记）清理，需 dbPath 第二参；非缓存条目',
  },
  {
    key: 'src/process/gui-active.ts::clearGuiActive',
    why: '清 .gui-active 存活记录文件（GUI 退出/切书），非缓存数据',
  },
  {
    key: 'src/process/settings-context.ts::clearCharacterCardCache',
    why: '测试专用导出（零生产调用）；角色卡缓存键为角色卡目录路径、按 (mtimeMs,size) 指纹逐轮自愈，生产侧无书级清理面',
  },
  {
    key: 'src/state/batch-pause.ts::clearBatchPause',
    why: '工作区暂停记录（文件态用户数据）清理，非缓存',
  },
  {
    key: 'src/studio/server/api/books-lifecycle.ts::clearPendingEventMigration',
    why: '改名事件迁移待办档（userDataPath + 新 root 键）清理，非缓存；由改名路由按迁移结果直调',
  },
  {
    key: 'src/studio/web-next/src/api/audit.ts::clearAudit',
    why: 'web-next 前端树（浏览器侧 API 壳，按书名单键调服务端端点）——非进程内书键结果缓存，登记表语义不适用',
  },
  {
    key: 'src/studio/web-next/src/api/chat.ts::clearChatHistory',
    why: 'web-next 前端树（浏览器侧 API 壳，同上）——非进程内书键结果缓存',
  },
  {
    key: 'src/studio/web-next/src/composables/useChatComposer.ts::clearFailedDrafts',
    why: 'web-next 前端树（浏览器侧 composer 草稿态）——非进程内书键结果缓存',
  },
  {
    key: 'src/studio/web-next/src/stores/check.ts::clearFalsePositiveMarks',
    why: 'web-next 前端树（浏览器侧 store 误报标记，按书名）——非进程内书键结果缓存',
  },
  {
    key: 'src/studio/web-next/src/stores/check.ts::clearFalsePositiveMarksForDoc',
    why: 'web-next 前端树（浏览器侧 store 误报标记，按书名 + 文档 id）——非进程内书键结果缓存',
  },
]

describe('书键缓存登记制对账（机器门）', () => {
  const scanned = scanInvalidatorExports()

  it('门自身：同义族（forget|invalidate|clear）× 两形态（函数声明 / const 箭头）全识别', () => {
    // src 现存无 `export const <失效族>` 形态（const 箭头覆盖面靠本用例锚定）；非导出行不误捕。
    const fixture = [
      'export function forgetA(bookRoot: string): void {}',
      'export function invalidateB(bookRoot: string): void {}',
      'export async function clearC(bookRoot: string): Promise<void> {}',
      'export const forgetD = (bookRoot: string): void => {}',
      'export const invalidateE: (r: string) => void = () => {}',
      'export const clearF = (): void => {}',
      'function clearNotExported(): void {}',
      'const forgetLocal = (): void => {}',
      'export function buildIndex(bookRoot: string): void {}',
    ].join('\n')
    expect(matchInvalidatorExports(fixture, 'fixture.ts').map((e) => e.fn)).toEqual([
      'forgetA',
      'invalidateB',
      'clearC',
      'forgetD',
      'invalidateE',
      'clearF',
    ])
  })

  it('前置：扫描面非空；登记表已由聚合入口装满（历史 22 条挂点全量在册）', () => {
    expect(scanned.length).toBeGreaterThan(0)
    const registered = listBookKeyedCaches()
    // 下限锚 = 历史清单条数：确有缓存下线须同步改此数（并在评审说明），防「静默消失」。
    expect(registered.length).toBeGreaterThanOrEqual(22)
    for (const e of registered) {
      expect(typeof e.forget).toBe('function')
      expect(e.name.length).toBeGreaterThan(0)
    }
  })

  it('正向：src/** 每个缓存失效族导出都已在登记表（或在豁免清单内——逐项 + 理由）', () => {
    const registeredFnNames = new Set(listBookKeyedCaches().map((e) => e.forget.name))
    const exempt = new Set(EXEMPT_CACHE_INVALIDATORS.map((e) => e.key))
    const missing: string[] = []
    for (const s of scanned) {
      if (registeredFnNames.has(s.fn)) continue
      if (exempt.has(`${s.rel}::${s.fn}`)) continue
      missing.push(
        `${s.rel} 的 ${s.fn}(${s.firstParam ?? '无参/解构首参'}…) 未登记——书键缓存须在模块顶层 ` +
          'registerBookKeyedCache 自登记（确非书键缓存则在门内逐项豁免并写明理由）；' +
          '否则删/改名后同名重建书会读到跨书陈旧数据',
      )
    }
    expect(missing, '存在未登记的书键缓存失效族导出:\n' + missing.join('\n')).toEqual([])
  })

  it('反向：登记表每项都来自真实源码导出（防登记死项 / 重名）', () => {
    const scannedFnNames = new Set(scanned.map((s) => s.fn))
    const problems: string[] = []
    const seen = new Set<string>()
    for (const e of listBookKeyedCaches()) {
      if (seen.has(e.name)) problems.push(`登记名重复：${e.name}`)
      seen.add(e.name)
      const fn = e.forget.name
      // 匿名登记（内联闭包，如 shelf-guard 整表清扫）无源码函数名可反查——其存在性由
      // 聚合入口被 import 时执行到该登记语句保证（本文件顶部 import 即触发）。
      if (fn !== '' && !scannedFnNames.has(fn)) {
        problems.push(`登记项 ${e.name} 的失效函数 ${fn} 在 src/** 无对应 forget* 导出（登记死项）`)
      }
    }
    expect(problems, '登记表存在死项/重名:\n' + problems.join('\n')).toEqual([])
  })

  it('豁免清单无僵尸：每条豁免都对应一个真实扫描项（防白名单漂移）', () => {
    const scannedKeys = new Set(scanned.map((s) => `${s.rel}::${s.fn}`))
    const stale = EXEMPT_CACHE_INVALIDATORS.filter((e) => !scannedKeys.has(e.key)).map((e) => e.key)
    expect(stale, '豁免条目已无对应源码导出（已治理/被改名），请从清单移除:\n' + stale.join('\n')).toEqual([])
  })
})
