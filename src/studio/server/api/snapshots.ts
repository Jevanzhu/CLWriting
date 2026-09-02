/**
 * 快照 REST 端点（单章版本回滚）。
 *
 * GET  /api/books/:name/documents/:docId/snapshots           → 版本列表（时间/来源/字数）
 * GET  /api/books/:name/documents/:docId/snapshots/:id       → 单个版本内容（预览）
 * POST /api/books/:name/documents/:docId/snapshots/:id/restore → 恢复该版本
 *
 * 保留策略两层链（2026-08-19 起只走全局，R34D-20 校正头注）：global.json snapMax*
 * （全局）→ 硬编码 14 天 / 30 个。book.yaml snapshots 书级段已砍除，不再参与（旧值忽略）。
 *
 * 恢复走 DocumentService.save + origin='restore'，因此会自动再留一份当前内容的底
 * （maybeSnapshot 的 restore 分支 force 不节流）——恢复本身可再撤销。
 * R34D-18（三十四轮）：恢复按字节保真读（readSnapshotRaw）——utf-8 档解码为精确
 * 文本（journal 全文快照/字数口径照旧），非 UTF-8 字节档（R26-52 GBK 留底）原字节
 * 透传 save，恢复不再强制失真（U+FFFD）。
 * 复用 documents.ts 的 service 缓存：两个队列会破坏串行写保证。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readdirSync, statSync, lstatSync, existsSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBooks } from '../../../install/books.js'
import { listSnapshotEntries, readSnapshot, readSnapshotRaw, pruneSnapshots, DEFAULT_SNAPSHOT_POLICY, readGlobalSnapshotPolicy } from '../../../document/snapshot.js'
import { readManifest } from '../../../document/manifest.js'
import { safeDocId } from '../../../fs/safe-path.js' // P3-1：docId 白名单校验共享（不内联手写）
import { isUtf8Bytes } from '../../../document/service.js' // R34D-18：字节档判定共享（M-5 防线同源口径）
import { readFile, parseFlat } from '../../../format/frontmatter.js'
import { countWords } from '../../../format/words.js'
import { ulid } from '../../../fs/id.js'
import { getOrCreateService } from './documents.js'
import { acquireTaskGate } from './task-gate.js' // R26-67（二十六轮）：prune 书级任务闸
import type { Revision } from '../../../document/revision.js'

interface SnapshotCtx {
  workDir: string | null
  /** APP 级数据目录（Electron userData / CLI 约定路径）：global.json 存全局保留策略 */
  userDataPath: string | null
}

/** 定位书 + 文档：返回 bookRoot 与文档相对路径。userDataPath 传给 DocumentService
 *  （缓存实例共享——先经此创建的实例也要带全局策略，否则恢复端点写时清理退化为两层链）。 */
async function resolveDoc(
  workDir: string | null,
  name: string | undefined,
  docId: string,
  userDataPath: string | null = null,
): Promise<{ bookRoot: string; relPath: string; snapshotsDir: string } | { error: string; status: number; code: string }> {
  if (!workDir) return { error: '未定位到工作目录', status: 400, code: 'NO_WORKDIR' }
  if (!name) return { error: '缺少书名', status: 400, code: 'BAD_INPUT' }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404, code: 'NOT_FOUND' }
  const bookRoot = join(workDir, entry.path)
  // docId → relPath（含 legacy 旧文件首次补登记，resolvePathAsync → 异步收编孪生；这里
  // 不能换 resolveDocEntry——legacy 补登记是写操作。残留清偿批：原同步 resolvePath 的
  // 收编段走 withManifestLock 同步睡，快照端点已改异步孪生不再阻塞事件循环）
  const relPath = await getOrCreateService(bookRoot, userDataPath).resolvePathAsync(docId)
  if (!relPath) return { error: `文档ID未登记：${docId}`, status: 404, code: 'NOT_FOUND' }
  return { bookRoot, relPath, snapshotsDir: join(bookRoot, '工作区', '.版本') }
}

/** 递归统计某目录下 .md 文件：数量 + 字节总量 + pinned（front matter 含「永久: true」）。
 *  R-15（第十六轮）：symlink 环防护——lstatSync 判定（不跟随 symlink），symlink 条目
 *  （目录/文件）按 M-9 同族口径跳过。原 statSync 跟随链接，指向祖先目录的 symlink
 *  会让 walk 无限递归栈溢出挂死端点。 */
function scanVersionsDir(
  dir: string,
): { count: number; bytes: number; pinnedCount: number } {
  let count = 0
  let bytes = 0
  let pinnedCount = 0
  if (!existsSync(dir)) return { count, bytes, pinnedCount }
  const walk = (d: string): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith('._')) continue // AppleDouble 伴生文件不计
      const p = join(d, n)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      // R-15：symlink 一律跳过（不跟随——防目录环，也防外指 symlink 逃逸统计面）
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(p)
      } else if (n.endsWith('.md')) {
        count++
        bytes += st.size
        // pinned 判定：front matter「永久: true」（finalize 定稿版本）
        try {
          const r = readFile(p)
          if (r.ok) {
            const map = parseFlat(r.fmRaw)
            if (map.get('永久') === true || map.get('永久') === 'true') pinnedCount++
          }
        } catch {
          /* 读 FAIL 不算 pinned */
        }
      }
    }
  }
  walk(dir)
  return { count, bytes, pinnedCount }
}

// 全局保留策略读取器已上移 document/snapshot.ts（service.ts 写时清理也走同一三层链）

// ── R36-7（三十六轮）：version-stats 全书快照统计 5s TTL 缓存 ─────────────────
// 端点递归遍历 .版本 全目录（含 pinned 判定逐文件 fm 读 + parse）+ manifest 全表，
// 进页/轮询/刷新反复触发。手法对齐 search.ts R35-7（mtime 探针 + TTL）：递归
// mtime/size 探针（symlink 跳过，与 scanVersionsDir R-15 同口径）——命中即跳过
// 逐文件 fm 读 + manifest 整读；TTL 5s 兜底探针不可见的变化（mtime 粒度粗/同拍同
// 尺寸重写）。写侧另挂同文件失效点（prune/restore 落盘后 forgetVersionStatsCache）；
// 保存/定稿等外部快照写（documents.ts/service.ts 不在本批允许清单）靠探针见
// （新快照文件/新目录即变）与 TTL 兜底。
// R37-17（三十七轮）：递归签名之上再叠两级探针——第一级便宜目录指纹（见
// versionStatsProbe）命中即跳过递归签名 walk 本身（前端 3s 轮询此前每 poll 全量
// stat 重算签名）；指纹覆盖边界见该函数头注。
const VERSION_STATS_TTL_MS = 5000
const VERSION_STATS_MAX = 32

interface VersionStatsResult {
  snapshotBytes: number
  snapshotCount: number
  pinnedCount: number
  finalizedDocs: number
}
const versionStatsCache = new Map<string, { probe: string; result: VersionStatsResult; sig: string; ts: number }>()
let versionStatsTtlMs: number | null = null
/** R36-7：TTL 测试注入口（先例同 __setSearchCacheTtlForTest）。仅测试用。 */
export function __setVersionStatsTtlForTest(ms: number | null): void {
  versionStatsTtlMs = ms
}
/** R36-7：写侧失效挂点——prune/restore 落盘后调用（本文件内写路径）。 */
export function forgetVersionStatsCache(bookRoot: string): void {
  versionStatsCache.delete(bookRoot)
}
/** R36-7 回归观测钩子（生产零调用；先例同 __searchScanCountForTest）：缓存 MISS →
 *  全量重算计数。 */
let versionStatsScanCount = 0
export function __versionStatsScanCountForTest(): number {
  return versionStatsScanCount
}
export function __resetVersionStatsScanCountForTest(): void {
  versionStatsScanCount = 0
}
/** R37-17（三十七轮）回归观测钩子（生产零调用）：全量签名（versionStatsSignature
 *  递归 walk）执行计数——两级探针命中时应不再增长。 */
let versionStatsSigCount = 0
export function __versionStatsSigCountForTest(): number {
  return versionStatsSigCount
}
export function __resetVersionStatsSigCountForTest(): void {
  versionStatsSigCount = 0
}

/** stat 的 size:mtimeMs 签名（缺失 → '-'；读失败按缺失处理）。
 *  mtimeMs 保留亚毫秒小数（同 search.ts dirSignature 口径），降低同毫秒重写漏探针概率。 */
function sigStatFor(fp: string): string {
  try {
    const st = statSync(fp)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return '-'
  }
}

/** R36-7：version-stats 的盘面签名——manifest size:mtime + .版本 递归每条目
 *  name:size:mtime（读侧内容全部由签名覆盖：命中即跳过逐文件 fm 读 + manifest 整读）。
 *  AppleDouble 伴生文件不计、symlink 跳过，口径与 scanVersionsDir 逐位一致。 */
function versionStatsSignature(bookRoot: string): string {
  const parts: string[] = [`m:${sigStatFor(join(bookRoot, '项目', '文档清单.jsonl'))}`]
  const versionsDir = join(bookRoot, '工作区', '.版本')
  if (!existsSync(versionsDir)) {
    parts.push('-')
    return parts.join(',')
  }
  const walk = (d: string, prefix: string): void => {
    let names: string[]
    try {
      names = readdirSync(d).sort()
    } catch {
      if (prefix) parts.push(`d:${prefix}:<unreadable>`)
      else parts.push('<unreadable>')
      return
    }
    for (const n of names) {
      if (n.startsWith('._')) continue
      const p = join(d, n)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue // R-15：不跟随（目录环/外指逃逸同防线）
      const rel = prefix ? `${prefix}/${n}` : n
      if (st.isDirectory()) {
        parts.push(`d:${rel}:${st.mtimeMs}`)
        walk(p, rel)
      } else {
        parts.push(`f:${rel}:${st.size}:${st.mtimeMs}`)
      }
    }
  }
  walk(versionsDir, '')
  return parts.join(',')
}

/** R36-7：version-stats 计算体（原 handler 内联逻辑原样下沉，行为不变）。 */
function computeVersionStats(bookRoot: string): VersionStatsResult {
  const versionsDir = join(bookRoot, '工作区', '.版本')
  const scan = scanVersionsDir(versionsDir)
  // 定稿章节数：manifest 中 finalizedRevision 非空的文档条目数
  const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
  let finalizedDocs = 0
  for (const e of manifest.entries.values()) {
    if (e.nodeType === 'document' && e.finalizedRevision) finalizedDocs++
  }
  return {
    snapshotBytes: scan.bytes,
    snapshotCount: scan.count,
    pinnedCount: scan.pinnedCount,
    finalizedDocs,
  }
}

/** R37-17（三十七轮）：version-stats 两级探针的第一级——便宜目录指纹（先例
 *  search.ts R35-7 dirSignature 的 statSync(dir).mtimeMs，按本端点全量签名的实际
 *  读面设计构成）：
 *  - manifest（项目/文档清单.jsonl）size:mtimeMs——manifest 是单文件内容写（原子
 *    rename 重写、不改父目录条目集），目录 mtime 探不到，必须以文件 stat 入指纹；
 *  - .版本 顶层目录 mtime——doc 子目录增删改名可见；
 *  - .版本 每个直接子目录的 mtime——快照 .md 在其 doc 目录内的增删/原子重写可见
 *    （快照档写后不改：应用侧变更 = 新增落盘（同目录 rename / exclusive create）、
 *    prune 删除、新 doc 目录，均刷对应目录 mtime；r36 回归「写进既有 doc 目录的
 *    新快照即时失效」必须由子目录 mtime 承担——顶层 stat 探不到）。
 *  覆盖边界（如实）：目录 mtime 只反映直接子项增删/改名与同目录 rename 落盘——
 *  外部进程对快照文件的「非 rename 就地内容改写」一级探针不可见，由 TTL 到期
 *  （≤5s）走第二级全量签名重算兜底（与 R36-7「TTL 兜底探针不可见变化」既有口径
 *  一致）；.版本 更深层嵌套（>1 层子目录，现行布局无此形态）同理由 TTL 兜底。
 */
function versionStatsProbe(bookRoot: string): string {
  const parts: string[] = [`m:${sigStatFor(join(bookRoot, '项目', '文档清单.jsonl'))}`]
  const versionsDir = join(bookRoot, '工作区', '.版本')
  try {
    parts.push(`d:${statSync(versionsDir).mtimeMs}`)
    for (const n of readdirSync(versionsDir).sort()) {
      if (n.startsWith('._')) continue // AppleDouble 伴生不计（与全量签名 walk 同口径）
      try {
        parts.push(`${n}:${statSync(join(versionsDir, n)).mtimeMs}`)
      } catch {
        parts.push(`${n}:-`) // 子项竞态消失：按变化论（≠上次指纹必 miss → 走全量签名）
      }
    }
  } catch {
    parts.push('-') // .版本 不存在/不可读——与全量签名的缺席分支同语义
  }
  return parts.join(',')
}

/** R37-17（三十七轮）：version-stats 聚合查询两级探针化（递归 mtime 探针 + 5s TTL
 *  缓存壳之上加便宜目录指纹）。前端 3s 轮询此前每 poll 都全量重算递归签名（大书
 *  数千次 lstat）；现在第一级 O(子目录数) stat 未变即复用，指纹变化才走第二级
 *  （R36-7 原全量签名），签名仍一致（指纹抖动，如原子写 tmp 中间态已消失）则回填
 *  指纹复用结果。导出供回归测试直测（同 searchBookCached 口径）。 */
export function getVersionStatsCached(bookRoot: string): VersionStatsResult {
  const now = Date.now()
  const ttl = versionStatsTtlMs ?? VERSION_STATS_TTL_MS
  const cached = versionStatsCache.get(bookRoot)
  // 第一级：便宜目录指纹未变（且 TTL 内）→ 直接复用，跳过全量递归签名 walk
  const probe = versionStatsProbe(bookRoot)
  if (cached && now - cached.ts < ttl && cached.probe === probe) {
    return cached.result
  }
  // 第二级：指纹变了才全量签名（R36-7 原口径）；签名一致 → 回填指纹、复用结果免重算
  versionStatsSigCount += 1
  const sig = versionStatsSignature(bookRoot)
  if (cached && now - cached.ts < ttl && cached.sig === sig) {
    cached.probe = probe
    return cached.result
  }
  versionStatsScanCount += 1
  const result = computeVersionStats(bookRoot)
  // 简单 FIFO 淘汰（Map 保插入序）：超上限丢最旧条目，防长期运行的书库累积
  if (versionStatsCache.size >= VERSION_STATS_MAX) {
    const oldest = versionStatsCache.keys().next().value
    if (oldest !== undefined) versionStatsCache.delete(oldest)
  }
  versionStatsCache.set(bookRoot, { probe, sig, result, ts: now })
  return result
}

export function registerSnapshotRoutes(ctx: SnapshotCtx): void {
  // 版本统计（改动 10b）：全书快照占用 / 总数 / 定稿章节数 / 定稿版本数
  defineRoute('books.version-stats', {
    method: 'GET',
    path: '/api/books/:name/version-stats',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R36-7：递归 mtime 探针 + 5s TTL 缓存壳（命中即跳过 .版本 逐文件 fm 读 +
      // manifest 整读；计算体见 computeVersionStats，行为与改前逐位一致）
      const st = getVersionStatsCached(r.bookRoot)
      reply(res, 200, {
        ok: true,
        snapshotBytes: st.snapshotBytes,
        snapshotCount: st.snapshotCount,
        pinnedCount: st.pinnedCount,
        finalizedDocs: st.finalizedDocs,
      })
    },
  })

  // 立即清理过期编辑快照（改动 10b S24）：按保留策略（max_days/max_count）扫全书所有
  // docId 的版本目录 prune 一遍。pinned 定稿版本永久保留不清理。返回清理的文件数。
  defineRoute('books.versions.prune', {
    method: 'POST',
    path: '/api/books/:name/versions/prune',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R26-67（二十六轮）：书级任务闸全程持闸——prune 批量删除 .版本 快照，与生成类
      // 任务（写稿/onboard 等收尾会写快照）及删书/改名 busyGate（crossProcessHeldTask
      // GatesFor 借 KNOWN_ACTIONS 正向枚举）的互斥面此前缺失；闸忙 409 口径对齐
      // onboard-save 等同类端点。action 已登记 task-gate.ts KNOWN_ACTIONS（R77-2 静态对账门）。
      const release = acquireTaskGate(params['name']!, 'versions-prune')
      if (!release) return replyError(res, 409, 'BUSY', '本书快照清理已在进行中，请稍后再试')
      try {
        const bookRoot = r.bookRoot
        const versionsDir = join(bookRoot, '工作区', '.版本')
        if (!existsSync(versionsDir)) return reply(res, 200, { ok: true, removed: 0 })

        // 保留策略（2026-08-19 起只走全局）：global.json snapMax* → 硬编码 14 天 / 30 个；
        // book.yaml snapshots 段已砍书级，不再参与（旧值忽略）。
        const global = readGlobalSnapshotPolicy(ctx.userDataPath)
        const policy = {
          maxDays: global.maxDays ?? 14,
          maxCount: global.maxCount ?? 30,
          throttleMinutes: DEFAULT_SNAPSHOT_POLICY.throttleMinutes,
        }

        // 收集所有 docId（manifest 已登记的 + 版本目录里实际存在的）
        const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
        const ids = new Set(manifest.entries.keys())
        try {
          for (const d of readdirSync(versionsDir)) {
            // dd-P3：readdir 后目录项可能并发消失——单项失败跳过，防裸 ENOENT 中断整轮 prune
            try {
              if (statSync(join(versionsDir, d)).isDirectory()) ids.add(d)
            } catch {
              continue
            }
          }
        } catch {
          /* 目录读取失败用 manifest 集合 */
        }

        let removed = 0
        for (const docId of ids) {
          // P3-1：docId 白名单校验共享（防 manifest 篡改导致的路径穿越删除）
          if (!safeDocId(docId)) continue
          try {
            removed += pruneSnapshots(versionsDir, docId, policy)
          } catch {
            /* 单文档清理失败不阻断全书 */
          }
        }
        // R36-7：快照被删 → version-stats 缓存失效（探针/TTL 兜底）
        forgetVersionStatsCache(bookRoot)
        reply(res, 200, { ok: true, removed })
      } finally {
        release()
      }
    },
  })

  // 版本列表（新的在前）
  defineRoute('books.documents.snapshots', {
    method: 'GET',
    path: '/api/books/:name/documents/:docId/snapshots',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const docId = params['docId'] ?? ''
      const r = await resolveDoc(ctx.workDir, params['name'], docId, ctx.userDataPath)
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      reply(res, 200, { ok: true, entries: listSnapshotEntries(r.snapshotsDir, docId, countWords) })
    },
  })

  // 单个版本内容（预览用）
  defineRoute('books.documents.snapshots.get', {
    method: 'GET',
    path: '/api/books/:name/documents/:docId/snapshots/:id',
    handler: async ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const docId = params['docId'] ?? ''
      const r = await resolveDoc(ctx.workDir, params['name'], docId, ctx.userDataPath)
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const snap = readSnapshot(r.snapshotsDir, docId, params['id'] ?? '')
      if (!snap) return replyError(res, 404, 'NOT_FOUND', '版本不存在')
      reply(res, 200, { ok: true, content: snap.content, meta: snap.meta })
    },
  })

  // 恢复：用该版本内容覆盖当前正文（当前内容自动留底）
  defineRoute('books.documents.snapshots.restore', {
    method: 'POST',
    path: '/api/books/:name/documents/:docId/snapshots/:id/restore',
    handler: async ({ params }, req: IncomingMessage, res: ServerResponse) => {
      const docId = params['docId'] ?? ''
      const r = await resolveDoc(ctx.workDir, params['name'], docId, ctx.userDataPath)
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      // R34D-18（三十四轮）：字节保真读——此前 readSnapshot 的 utf-8 文本视图对
      // R26-52 字节档（非 UTF-8 源按原字节留底）必有损（U+FFFD 不可逆），恢复形同
      // 虚设。utf-8 档解码回精确文本（合法 utf-8 字节 ↔ 字符串双射，journal 全文
      // 快照/字数增量/回复体口径照旧）；非 UTF-8 字节档原 Buffer 透传 save 原字节
      // 直存（save 侧 M-5 覆写防线对 Buffer 放行——该防线的威胁模型是文本往返
      // 失真覆写，字节保真写不在其内）。
      const snap = readSnapshotRaw(r.snapshotsDir, docId, params['id'] ?? '')
      if (!snap) return replyError(res, 404, 'NOT_FOUND', '版本不存在')
      const content: string | Buffer = isUtf8Bytes(snap.content)
        ? snap.content.toString('utf-8')
        : snap.content

      const body = (await readJson(req)) as { expectedRevision?: unknown }
      const expectedRevision =
        typeof body.expectedRevision === 'string' ? (body.expectedRevision as Revision) : null
      if (expectedRevision === null) {
        return replyError(res, 400, 'BAD_INPUT', 'expectedRevision 必填')
      }

      const outcome = await getOrCreateService(r.bookRoot, ctx.userDataPath).save(docId, r.relPath, {
        content,
        expectedRevision,
        operationId: ulid(),
        origin: 'restore',
        reason: `恢复到 ${new Date(snap.meta.time).toLocaleString('zh-CN')} 的版本`,
      })
      if (!outcome.ok) {
        const status = outcome.code === 'REVISION_CONFLICT' ? 409 : 400
        // N-2（第十二轮）：收编 replyError 单一出口（去掉 ok:false 冗余位）
        return replyError(res, status, outcome.code, outcome.reason)
      }
      // 回复体是编辑器缓冲区的文本视图：utf-8 档即原文；字节档为失真视图（编辑器
      // 世界是 utf-8 文本，后续保存由 M-5 防线拦截提示先转码——不产生静默覆写）
      const view = typeof content === 'string' ? content : content.toString('utf-8')
      // R36-7：恢复即新快照（maybeSnapshot restore 分支强制不节流）→ version-stats
      // 缓存失效（探针/TTL 兜底）
      forgetVersionStatsCache(r.bookRoot)
      reply(res, 200, { ok: true, revision: outcome.revision, content: view })
    },
  })
}
