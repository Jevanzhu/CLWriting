/**
 * 进程级 md 文件文本指纹缓存（R47-5/R47-10/R47-27，四十七轮）。
 *
 * 动机：三处独立消费方此前各持一份私有正文缓存/无缓存——document/foreshadow.ts
 * chapterTextCache（R66-6）与 metrics/style.ts chapterBodyCache（R66-24）各 4096 条
 * 存**同一批章文件的去 fm 正文**（双份驻留）；check/leads.ts chapterTextOf 仅调用内
 * Map（每次机检全量重读）；process/book-search.ts searchFile 每查询裸 readFileSync
 * （无命中时读完全书）。收敛为单源后：同指纹零重读、驻留总量减半、三消费方共享。
 *
 * 纪律（对齐 document/tree.ts probeCache / format/chapters.ts chapterDirCache /
 * R66-6 / R66-24 同款口径）：
 * - bigint stat 指纹（mtimeNs + size，撞车窗口 ns 级）——写必 bump mtime，自然失效，
 *   无需写路径挂钩；文件消失（TOCTOU）清条目；
 * - Map 插入序 FIFO 上限 4096（正文章数千级的 4 倍余量，防长跑无界）；
 * - 只缓存**原始文本**，fm 剥离/降级语义留给调用方（各消费方对「无 fm/未闭合 fm/
 *   读失败」的降级口径不同：foreshadow 归 ''、style 归 null、leads 走 bodyOf 裸文
 *   透传、book_search 要原文含 fm——单源不吞并语义）。
 */
import { readFileSync, statSync } from 'node:fs'
import { readFile as readFileAsync, stat as statAsync } from 'node:fs/promises'
import { sep } from 'node:path'

const MD_TEXT_CACHE_MAX = 4096
let mdTextCacheMax = MD_TEXT_CACHE_MAX
const mdTextCache = new Map<string, { mtimeNs: bigint; size: bigint; text: string; bytes: number }>()

// PM-8（性能与内存专项·2026-09-05）：字节预算双闸。条目数上限只防「条数无界」，挡不住
// 少量超大文档（全书单文件拖稿、超长设定卷）的驻留膨胀——4096 条 × 2MB 章 = 理论 8GB。
// 字节闸按 UTF-8 字节数计账：插入后超预算（默认 64MB，约 2000 万字全量正文 + 余量）
// 从最旧条目起逐出至预算内；恒保留最新一条（刚请求的条目逐出即缓存击穿抖动）。
const MD_TEXT_CACHE_MAX_BYTES = 64 * 1024 * 1024
let mdTextCacheMaxBytes = MD_TEXT_CACHE_MAX_BYTES
let mdTextCacheBytes = 0

function dropEntryLocked(abs: string): void {
  const e = mdTextCache.get(abs)
  if (e === undefined) return
  mdTextCacheBytes -= e.bytes
  mdTextCache.delete(abs)
}

function insertEntryLocked(abs: string, st: { mtimeNs: bigint; size: bigint }, text: string): void {
  dropEntryLocked(abs) // 同键覆写先扣旧字节，防双重计账
  if (mdTextCache.size >= mdTextCacheMax) {
    const oldest = mdTextCache.keys().next().value
    if (oldest !== undefined) dropEntryLocked(oldest)
  }
  const bytes = Buffer.byteLength(text)
  mdTextCache.set(abs, { mtimeNs: st.mtimeNs, size: st.size, text, bytes })
  mdTextCacheBytes += bytes
  while (mdTextCacheBytes > mdTextCacheMaxBytes && mdTextCache.size > 1) {
    const oldest = mdTextCache.keys().next().value
    if (oldest === undefined) break
    dropEntryLocked(oldest)
  }
}

/**
 * 带指纹缓存的 md 文本读取：未变（stat 指纹一致）→ 复用缓存零读；变更 → 重读；
 * 消失/读失败 → 清条目返回 null（调用方按各自降级口径处理）。
 */
export function readMdTextCached(abs: string): string | null {
  let st: { mtimeNs: bigint; size: bigint }
  try {
    st = statSync(abs, { bigint: true })
  } catch {
    // 文件消失（walk 与 read 之间被删）：清残留条目，按读失败降级（各调用方原口径）
    dropEntryLocked(abs)
    return null
  }
  const hit = mdTextCache.get(abs)
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) return hit.text
  let text: string
  try {
    text = readFileSync(abs, 'utf-8')
  } catch {
    dropEntryLocked(abs)
    return null
  }
  // FIFO 淘汰最旧（Map 保插入序，防长跑无界）+ 字节预算（PM-8）
  insertEntryLocked(abs, st, text)
  return text
}

/**
 * 异步孪生（R47-5，四十七轮）：指纹检查/读盘全 async（HTTP 端点搜索链不回退同步
 * IO——R37-5 异步化语义保持），与同步版共享同一指纹表（同步工具路径先扫过的文件
 * 端点路径直接命中，反之亦然）。降级语义同同步版：消失/读失败 → null。
 */
export async function readMdTextCachedAsync(abs: string): Promise<string | null> {
  let st: { mtimeNs: bigint; size: bigint }
  try {
    st = await statAsync(abs, { bigint: true })
  } catch {
    dropEntryLocked(abs)
    return null
  }
  const hit = mdTextCache.get(abs)
  if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) return hit.text
  let text: string
  try {
    text = await readFileAsync(abs, 'utf-8')
  } catch {
    dropEntryLocked(abs)
    return null
  }
  insertEntryLocked(abs, st, text)
  return text
}

/** 删书/改名的生命周期失效挂点（books.ts forgetBookKeyedCaches 接线）：按 bookRoot
 *  前缀清 mdTextCache 条目——缓存键由各消费方 walk 路径（自 join(bookRoot,…) 派生、
 *  未 resolve）构成，前缀用 bookRoot + sep 同源字节对齐（foreshadow 原本地缓存
 *  forgetChapterTextCacheForBook 同款口径）。返回清除条目数；清后键惰性重建。 */
export function forgetMdTextCacheForBook(bookRoot: string): number {
  const prefix = bookRoot + sep
  let removed = 0
  for (const key of mdTextCache.keys()) {
    if (key.startsWith(prefix)) {
      dropEntryLocked(key) // 走计账出口，字节闸账本同步扣减
      removed++
    }
  }
  return removed
}

/** R47-27：测试钩子（生产零调用，先例同 rebuild.ts __testHooks）——清缓存防用例间污染。 */
export const __mdTextCacheTestHooks = {
  clear(): void {
    mdTextCache.clear()
    mdTextCacheBytes = 0
  },
  size(): number {
    return mdTextCache.size
  },
  setMaxEntriesForTest(n: number | null): void {
    mdTextCacheMax = n ?? MD_TEXT_CACHE_MAX
  },
  // PM-8：字节计账观测 + 预算注入（生产零调用）
  bytes(): number {
    return mdTextCacheBytes
  },
  setMaxBytesForTest(n: number | null): void {
    mdTextCacheMaxBytes = n ?? MD_TEXT_CACHE_MAX_BYTES
  },
}
