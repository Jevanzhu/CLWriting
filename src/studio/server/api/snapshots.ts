/**
 * 快照 REST 端点（单章版本回滚）。
 *
 * GET  /api/books/:name/documents/:docId/snapshots           → 版本列表（时间/来源/字数）
 * GET  /api/books/:name/documents/:docId/snapshots/:id       → 单个版本内容（预览）
 * POST /api/books/:name/documents/:docId/snapshots/:id/restore → 恢复该版本
 *
 * 保留策略三层链：book.yaml snapshots → global.json snapMax*（全局默认）→ 硬编码 14 天 / 30 个。
 *
 * 恢复走 DocumentService.save + origin='restore'，因此会自动再留一份当前内容的底
 * （maybeSnapshot 的 restore 分支 force 不节流）——恢复本身可再撤销。
 * 复用 documents.ts 的 service 缓存：两个队列会破坏串行写保证。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { defineRoute } from './schema.js'
import { readJson, reply, replyError } from '../http.js'
import { resolveBook } from '../book-context.js'
import { readBooks } from '../../../install/books.js'
import { listSnapshotEntries, readSnapshot, pruneSnapshots, DEFAULT_SNAPSHOT_POLICY, readGlobalSnapshotPolicy } from '../../../document/snapshot.js'
import { readManifest } from '../../../document/manifest.js'
import { safeDocId } from '../../../fs/safe-path.js' // P3-1：docId 白名单校验共享（不内联手写）
import { readFile, parseFlat } from '../../../format/frontmatter.js'
import { countWords } from '../../../format/words.js'
import { ulid } from '../../../fs/id.js'
import { getOrCreateService } from './documents.js'
import type { Revision } from '../../../document/revision.js'

interface SnapshotCtx {
  workDir: string | null
  /** APP 级数据目录（Electron userData / CLI 约定路径）：global.json 存全局保留策略 */
  userDataPath: string | null
}

/** 定位书 + 文档：返回 bookRoot 与文档相对路径。userDataPath 传给 DocumentService
 *  （缓存实例共享——先经此创建的实例也要带全局策略，否则恢复端点写时清理退化为两层链）。 */
function resolveDoc(
  workDir: string | null,
  name: string | undefined,
  docId: string,
  userDataPath: string | null = null,
): { bookRoot: string; relPath: string; snapshotsDir: string } | { error: string; status: number; code: string } {
  if (!workDir) return { error: '未定位到工作目录', status: 400, code: 'NO_WORKDIR' }
  if (!name) return { error: '缺少书名', status: 400, code: 'BAD_INPUT' }
  const entry = readBooks(workDir).find((b) => b.name === name)
  if (!entry) return { error: `没有这本书：${name}`, status: 404, code: 'NOT_FOUND' }
  const bookRoot = join(workDir, entry.path)
  // docId → relPath（含 legacy 旧文件首次补登记，service.resolvePath → adoptLegacyDoc；这里不能换 resolveDocEntry——legacy 补登记是写操作）
  const relPath = getOrCreateService(bookRoot, userDataPath).resolvePath(docId)
  if (!relPath) return { error: `文档ID未登记：${docId}`, status: 404, code: 'NOT_FOUND' }
  return { bookRoot, relPath, snapshotsDir: join(bookRoot, '工作区', '.版本') }
}

/** 递归统计某目录下 .md 文件：数量 + 字节总量 + pinned（front matter 含「永久: true」）。 */
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
        st = statSync(p)
      } catch {
        continue
      }
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

export function registerSnapshotRoutes(ctx: SnapshotCtx): void {
  // 版本统计（改动 10b）：全书快照占用 / 总数 / 定稿章节数 / 定稿版本数
  defineRoute('books.version-stats', {
    method: 'GET',
    path: '/api/books/:name/version-stats',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const r = resolveBook(ctx.workDir, params['name'])
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const bookRoot = r.bookRoot
      const versionsDir = join(bookRoot, '工作区', '.版本')
      const scan = scanVersionsDir(versionsDir)
      // 定稿章节数：manifest 中 finalizedRevision 非空的文档条目数
      const manifest = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
      let finalizedDocs = 0
      for (const e of manifest.entries.values()) {
        if (e.nodeType === 'document' && e.finalizedRevision) finalizedDocs++
      }
      reply(res, 200, {
        ok: true,
        snapshotBytes: scan.bytes,
        snapshotCount: scan.count,
        pinnedCount: scan.pinnedCount,
        finalizedDocs,
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
      reply(res, 200, { ok: true, removed })
    },
  })

  // 版本列表（新的在前）
  defineRoute('books.documents.snapshots', {
    method: 'GET',
    path: '/api/books/:name/documents/:docId/snapshots',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const docId = params['docId'] ?? ''
      const r = resolveDoc(ctx.workDir, params['name'], docId, ctx.userDataPath)
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      reply(res, 200, { ok: true, entries: listSnapshotEntries(r.snapshotsDir, docId, countWords) })
    },
  })

  // 单个版本内容（预览用）
  defineRoute('books.documents.snapshots.get', {
    method: 'GET',
    path: '/api/books/:name/documents/:docId/snapshots/:id',
    handler: ({ params }, _req: IncomingMessage, res: ServerResponse) => {
      const docId = params['docId'] ?? ''
      const r = resolveDoc(ctx.workDir, params['name'], docId, ctx.userDataPath)
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
      const r = resolveDoc(ctx.workDir, params['name'], docId, ctx.userDataPath)
      if ('error' in r) return replyError(res, r.status, r.code, r.error)
      const snap = readSnapshot(r.snapshotsDir, docId, params['id'] ?? '')
      if (!snap) return replyError(res, 404, 'NOT_FOUND', '版本不存在')

      const body = (await readJson(req)) as { expectedRevision?: unknown }
      const expectedRevision =
        typeof body.expectedRevision === 'string' ? (body.expectedRevision as Revision) : null
      if (expectedRevision === null) {
        return replyError(res, 400, 'BAD_INPUT', 'expectedRevision 必填')
      }

      const outcome = await getOrCreateService(r.bookRoot, ctx.userDataPath).save(docId, r.relPath, {
        content: snap.content,
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
      reply(res, 200, { ok: true, revision: outcome.revision, content: snap.content })
    },
  })
}
