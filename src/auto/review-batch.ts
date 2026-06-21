/**
 * 批量审稿 + 逐章定稿编排 —— 依据 M6 #35。
 *
 * 作者回来经态 8 路由进入批量审稿：
 * - 列待审章（扫 待定稿/ 完成章，不含 .isolated/）
 * - 逐章裁决：作者写 待定稿/<章>/审稿.md（approved/rejected）
 * - 逐章定稿：审过的章 doFinalize（workDir 指向待定稿章目录，R2 适配）→ 删该章目录 + completed 移除
 * - 整批回滚：未定稿清暂存（不涉 git）
 *
 * 品味归人（原则 7）：审稿是作者硬闸，连写绝不替作者定稿。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { readFile } from '../format/frontmatter.js'
import { readChapter } from '../format/chapters.js'
import { rebuild } from '../cache/rebuild.js'
import { doFinalize } from '../finalize/commit.js'
import { aggregateLeadUpdates, readChapterLeadUpdates } from '../process/lead-updates.js'
import { readReviewVerdict, REVIEW_VERDICT_MARKER } from '../review/run.js'
import { atomicWriteFile } from '../fs/atomic.js'
import {
  pendingRoot,
  readBatchProgress,
  writeBatchProgress,
  clearPendingBatch,
} from './batch.js'

/** 待审章信息（态 8 列出 + 批量审稿呈现）。 */
export interface PendingChapter {
  chapter: number
  title: string
  /** 待定稿章目录绝对路径 */
  dir: string
  /** 是否已裁决（有审稿.md） */
  hasVerdict: boolean
  /** 裁决结果（approved/rejected/undefined 未裁决） */
  verdict?: 'approved' | 'rejected'
}

/** 列待审章（扫 待定稿/ 完成章，排除 .isolated/）。 */
export function listPendingChapters(bookRoot: string): PendingChapter[] {
  const root = pendingRoot(bookRoot)
  if (!existsSync(root)) return []
  const out: PendingChapter[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue // 跳过 .isolated/
    const m = entry.name.match(/^(\d+)-(.+)$/)
    if (!m) continue
    const chapter = Number(m[1])
    const title = m[2]!
    const dir = join(root, entry.name)
    const verdict = readChapterVerdict(dir)
    out.push({
      chapter,
      title,
      dir,
      hasVerdict: verdict !== undefined,
      ...(verdict ? { verdict } : {}),
    })
  }
  return out.sort((a, b) => a.chapter - b.chapter)
}

/** 读待定稿章的审稿裁决（approved=通过 / rejected=打回 / undefined 未裁决）。 */
function readChapterVerdict(chapterDir: string): 'approved' | 'rejected' | undefined {
  const verdictPath = join(chapterDir, '审稿.md')
  if (!existsSync(verdictPath)) return undefined
  const text = readFileSync(verdictPath, 'utf-8')
  // approved：精确 marker + verdict: 通过（复用 readReviewVerdict 契约）
  const approved = readReviewVerdict(chapterDir).approved
  if (approved) return 'approved'
  // rejected：显式打回标记
  if (new RegExp(`${escapeRegExp(REVIEW_VERDICT_MARKER)}\\s*verdict:\\s*打回`).test(text)) return 'rejected'
  return undefined
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 逐章定稿：把已 approved 的待定稿章逐章 doFinalize 原子 commit（#35 第 3 节，R2）。
 * workDir 指向 待定稿/<章>/，doFinalize 内核零改动；定稿后删该章目录 + completed 移除。
 *
 * @param bookRoot 书仓库根
 * @param chapters 要定稿的章号列表（须已 approved；未裁决章会被前置闸拦）
 * @returns 每章定稿结果
 */
export function finalizePendingChapters(
  bookRoot: string,
  chapters: number[],
): { chapter: number; ok: boolean; commitHash?: string; reason?: string }[] {
  const config = readBookConfig(join(bookRoot, 'book.yaml')).config
  const cachePath = join(bookRoot, '.cache', 'index.db')
  const results: { chapter: number; ok: boolean; commitHash?: string; reason?: string }[] = []

  // 逐章定稿（每章独立 db 连接 + rebuild）
  for (const chapter of chapters) {
    const dirName = findPendingDirByName(bookRoot, chapter)
    if (!dirName) {
      results.push({ chapter, ok: false, reason: `待定稿找不到第 ${chapter} 章` })
      continue
    }
    const chapterDir = join(pendingRoot(bookRoot), dirName)

    // 读草稿取章元数据 + 正文
    const draftPath = join(chapterDir, '草稿-1.md')
    if (!existsSync(draftPath)) {
      results.push({ chapter, ok: false, reason: `第 ${chapter} 章无草稿-1.md` })
      continue
    }
    const chapterRead = readChapter(draftPath)
    if (!chapterRead.ok) {
      results.push({ chapter, ok: false, reason: chapterRead.error.message })
      continue
    }
    const file = readFile(draftPath)
    if (!file.ok) {
      results.push({ chapter, ok: false, reason: file.error.message })
      continue
    }
    const chapterMeta = chapterRead.chapter

    // rebuild + doFinalize（workDir = 待定稿章目录，R2）
    const rebuilt = rebuild(bookRoot, cachePath)
    if (rebuilt.errors.length > 0) {
      results.push({ chapter, ok: false, reason: `源文件解析失败：${rebuilt.errors[0]!.message}` })
      continue
    }
    const db = new DatabaseSync(cachePath)
    try {
      const r = doFinalize({
        bookRoot,
        workDir: chapterDir,
        outlinePath: join(chapterDir, '细纲.md'),
        db,
        config,
        chapter: chapterMeta,
        body: file.body,
        fileName: `${chapterMeta.章号}-${chapterMeta.标题}.md`,
        hasReviewVerdict: readReviewVerdict(chapterDir).approved,
        leadUpdates: aggregateLeadUpdates(readChapterLeadUpdates(chapterDir), file.body, chapterMeta.章号),
      })
      if (!r.ok) {
        results.push({ chapter, ok: false, reason: r.reason })
        continue
      }
      results.push({ chapter, ok: true, commitHash: r.commitHash })

      // 定稿成功：删该章待定稿目录 + completed 移除
      rmSync(chapterDir, { recursive: true, force: true })
      removeCompleted(bookRoot, chapter)
    } finally {
      db.close()
    }
  }

  return results
}

/** 按 chapter 章号找待定稿章目录名（<章号4位>-<标题>）。 */
function findPendingDirByName(bookRoot: string, chapter: number): string | null {
  const root = pendingRoot(bookRoot)
  if (!existsSync(root)) return null
  const prefix = `${String(chapter).padStart(4, '0')}-`
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith(prefix)) return entry.name
  }
  return null
}

/** 从批次进度 completed 移除已定稿章。 */
function removeCompleted(bookRoot: string, chapter: number): void {
  const progress = readBatchProgress(bookRoot)
  if (!progress) return
  progress.completed = progress.completed.filter((c) => c !== chapter)
  writeBatchProgress(bookRoot, progress)
}

/**
 * 整批回滚：清待定稿暂存（未定稿，不涉 git，#35 第 4 节）。
 * 已定稿的部分要退 → 走 M3 revert（不在此处）。
 */
export function rollbackPendingBatch(bookRoot: string): { ok: true; cleared: number } | { ok: false; reason: string } {
  return clearPendingBatch(bookRoot)
}

/** 单章打回（rejected）：移出待审、标记重跑（#35 第 5 节）。 */
export function rejectPendingChapter(
  bookRoot: string,
  chapter: number,
  reason: string,
): { ok: true } | { ok: false; reason: string } {
  const dirName = findPendingDirByName(bookRoot, chapter)
  if (!dirName) return { ok: false, reason: `待定稿找不到第 ${chapter} 章` }
  // 打回 = 移到 .isolated/（与隔离章同构，留痕）
  const src = join(pendingRoot(bookRoot), dirName)
  const dst = join(pendingRoot(bookRoot), '.isolated', dirName)
  mkdirSync(join(pendingRoot(bookRoot), '.isolated'), { recursive: true })
  try {
    renameSync(src, dst)
  } catch {
    return { ok: false, reason: `打回第 ${chapter} 章移动失败` }
  }
  atomicWriteFile(
    join(dst, '.rejection.json'),
    JSON.stringify({ chapter, reason, at: new Date().toISOString() }, null, 2),
  )
  return { ok: true }
}
