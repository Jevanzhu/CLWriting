/**
 * R47-11（四十七轮）回归：walkSourceStats 增量探测的 per-book 3s TTL 节流。
 *
 * 动机：单章机检链（runCheckForDocument → rebuild → tryIncrementalRebuild）每调
 * 一次就对四棵源树逐文件 readdir+stat——SMB/网盘卷上单遍秒级。修复：照抄
 * state.ts sweepLastAt（R43-2）纪律的 Map<bookRoot, {at, stats}> 节流，仅
 * opts.throttleSourceProbe 调用方 opt-in（直连 rebuild 的「源变立即可见」语义
 * 被 rebuild.test.ts X-P2-1/R-13 系列锚定，默认不节流）。观测面：__testHooks
 * 的实际扫描计数（R37-16 chapterCacheStats 同款口径）。
 */
import { test, expect, vi, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { rebuild, __testHooks } from '../../src/cache/rebuild.js'
import { setMeta, getMeta } from '../../src/cache/sync.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

afterEach(() => {
  vi.useRealTimers()
  __testHooks.clearSourceProbeThrottle()
})

/** 最小长篇书骨架（book.yaml + 布线 + 正文一章；正文计数是本测的变更观测面） */
function makeBook(): { root: string; cachePath: string } {
  const root = mkdtempTracked(join(tmpdir(), 'r47-ttl-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'book:\n  title: 测试书\n  genre: 悬疑\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '001-第一章.md'),
    '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文。\n',
    'utf-8',
  )
  return { root, cachePath: join(root, '.cache', 'index.db') }
}

function writeChapter(root: string, no: number): void {
  writeFileSync(
    join(root, '写作', '正文', `00${no}-第${no}章.md`),
    `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n正文${no}。\n`,
    'utf-8',
  )
}

test('R47-11: TTL 窗口内二次探测不重扫（实际扫描计数不增），结果等值', () => {
  const { root, cachePath } = makeBook()
  try {
    __testHooks.clearSourceProbeThrottle()
    const r1 = rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(r1.chapterCount).toBe(1)
    expect(__testHooks.sourceProbeScanCount()).toBe(1) // 全量重建体的基准扫描（首调必真实扫描）
    // 窗内二次探测：节流命中 → 零重扫，仍增量跳过（chapterCount 从 meta 恢复）
    const r2 = rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(__testHooks.sourceProbeScanCount()).toBe(1)
    expect(r2.chapterCount).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-11: TTL 窗口外重扫（计数 +1），无变化仍增量跳过', () => {
  const { root, cachePath } = makeBook()
  try {
    __testHooks.clearSourceProbeThrottle()
    rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(__testHooks.sourceProbeScanCount()).toBe(1)
    vi.useFakeTimers()
    vi.advanceTimersByTime(3001) // TTL 过期（严格大于 3000ms 窗）
    const r = rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(__testHooks.sourceProbeScanCount()).toBe(2) // 过期 → 真实重扫
    expect(r.chapterCount).toBe(1) // 源未变 → 增量跳过语义不变
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-11: 窗口外源变更（新增章）→ 重扫且增量判定正确（变化 → 走全量）', () => {
  const { root, cachePath } = makeBook()
  try {
    __testHooks.clearSourceProbeThrottle()
    rebuild(root, cachePath, { throttleSourceProbe: true })
    writeChapter(root, 2)
    vi.useFakeTimers()
    vi.advanceTimersByTime(3001)
    const r = rebuild(root, cachePath, { throttleSourceProbe: true })
    // 过期重扫（首调基准 ×1 + 探测重扫 ×1；R48-14：变化后全量重建复用探测已扫 stats，
    // 不再第三次全树 stat）
    expect(__testHooks.sourceProbeScanCount()).toBe(2)
    expect(r.chapterCount).toBe(2) // count 变 → null → 全量重建，新章入库
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-11: 窗口内源变更 → 探测用缓存（登记的 ≤3s 可见延迟），窗口过期后自愈走全量', () => {
  const { root, cachePath } = makeBook()
  try {
    __testHooks.clearSourceProbeThrottle()
    rebuild(root, cachePath, { throttleSourceProbe: true })
    writeChapter(root, 2)
    // 窗内：节流命中 → 零重扫、按缓存基准判「无变」→ 增量跳过（登记取舍的陈旧臂）
    const stale = rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(__testHooks.sourceProbeScanCount()).toBe(1)
    expect(stale.chapterCount).toBe(1)
    // TTL 过期后：重扫 → count 变 → 全量重建自愈（探测重扫 ×1；R48-14 全量复用探测扫描）
    vi.useFakeTimers()
    vi.advanceTimersByTime(3001)
    const healed = rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(__testHooks.sourceProbeScanCount()).toBe(2)
    expect(healed.chapterCount).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-11: 直连 rebuild()（不节流）源变更立即可见——X-P2-1 即时增量判定不回归', () => {
  const { root, cachePath } = makeBook()
  try {
    __testHooks.clearSourceProbeThrottle()
    expect(rebuild(root, cachePath).chapterCount).toBe(1)
    writeChapter(root, 2)
    // 无节流旗：即使 3ms 前刚扫过（节流条目被真实扫描刷新），探测仍真实重扫
    expect(rebuild(root, cachePath).chapterCount).toBe(2)
    // 全量基准 ×1 + 探测 ×1 全真实（R48-14：全量重建复用探测已扫 stats，不再二次扫描）
    expect(__testHooks.sourceProbeScanCount()).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R47-11: db/meta 读取不受节流——窗内 errors 元数据失联仍走全量自愈（R62-30 口径保持）', () => {
  const { root, cachePath } = makeBook()
  try {
    __testHooks.clearSourceProbeThrottle()
    rebuild(root, cachePath, { throttleSourceProbe: true })
    // 篡改 error_count/errors（R62-30 的「元数据失联」形态）——窗内探测 stat 命中缓存，
    // 但 meta 读取每调执行 → 失联检出 → null → 全量重建自愈
    const db = new DatabaseSync(cachePath)
    try {
      setMeta(db, 'error_count', '1')
      setMeta(db, 'errors', '{oops')
    } finally {
      db.close()
    }
    const r = rebuild(root, cachePath, { throttleSourceProbe: true })
    expect(r.errors).toHaveLength(0)
    const db2 = new DatabaseSync(cachePath)
    try {
      expect(getMeta(db2, 'error_count')).toBe('0')
    } finally {
      db2.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
