/**
 * 定稿确认（去 git 版本系统版本）。
 *
 * 作者在 app 里编辑正文/设定文件 → 保存（内容 ≠ 定稿基线 → revision 态）
 * → 点「定稿」→ 写定稿版本（工作区/.版本/，pinned 永久保留）+ manifest 更新 finalizedRevision
 * → 当前指纹 == 基线 → 派生回 final。
 *
 * 不再依赖 git：不 add/commit，纯内容指纹 + 账本。幂等：当前指纹 == 已记录基线 → skipped。
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { readChapter } from '../format/chapters.js'
import { readManifest, writeManifest } from './manifest.js'
import { invalidateTreeIndex } from './tree.js'
import { computeRevision } from './revision.js'
import { writeVersion, VERSIONS_DIR_NAME } from './version.js'
import { countWords } from '../format/words.js'
import { splitFrontMatter } from '../format/frontmatter.js'
import { safeManifestPath } from '../fs/safe-path.js'

export type FinalizeOutcome =
  | { ok: true; status: 'final'; skipped: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'WRITE_ERROR'; error: string }

/**
 * 定稿确认：写 pinned 定稿版本 + manifest 更新定稿基线 → 回 final。
 *
 * @param bookRoot 书仓库根
 * @param docId 目标文档 id
 * @returns 是否成功 + 结果状态。
 */
export function finalizeRevision(bookRoot: string, docId: string): FinalizeOutcome {
  // docId → relPath（清单解析；未登记返回 NOT_FOUND）
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const relPath = lookupRelPath(docId, manifestPath)
  if (!relPath) return { ok: false, code: 'NOT_FOUND', error: '未在文档清单中找到该文档' }

  // 路径校验（防 manifest 篡改穿越——与其他 4 个 API 端点一致）
  const absPath = safeManifestPath(bookRoot, relPath)
  if (!absPath) return { ok: false, code: 'NOT_FOUND', error: '文档路径非法' }

  // 当前内容指纹
  const currentRev = computeRevision(absPath)

  // 幂等：当前指纹 == 已记录的定稿基线 → skipped，不重复写版本
  const manifest = readManifest(manifestPath)
  const entry = manifest.entries.get(docId)
  if (entry?.finalizedRevision === currentRev) {
    return { ok: true, status: 'final', skipped: true }
  }

  // 章号 + 标题（版本元信息用）；解析失败从文件名推断
  const rd = readChapter(absPath)
  const chapterNo = rd.ok ? rd.chapter.章号 : inferChapterFromName(relPath)
  const title = rd.ok && rd.chapter.标题 ? rd.chapter.标题 : basenameNoExt(relPath)

  // ① 写定稿版本（永久保留，pinned）
  try {
    const content = readFileSync(absPath, 'utf-8')
    const versionsDir = join(bookRoot, '工作区', VERSIONS_DIR_NAME)
    const split = splitFrontMatter(content)
    writeVersion(versionsDir, docId, content, {
      origin: 'finalize',
      reason: `定稿 ch:${String(chapterNo).padStart(4, '0')} ${title}`,
      baseRevision: currentRev,
      words: countWords(split ? split.body : content),
      pinned: true,
    })
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', error: `写版本失败：${e instanceof Error ? e.message : String(e)}` }
  }

  // ② manifest 更新定稿基线（entry 无则补建——旧书未登记首次定稿时落盘）
  if (!entry) {
    manifest.entries.set(docId, { id: docId, nodeType: 'document', path: relPath, parentId: null })
  }
  const next = manifest.entries.get(docId)!
  next.finalizedRevision = currentRev
  next.finalizedAt = new Date().toISOString()
  writeManifest(manifestPath, manifest)

  invalidateTreeIndex(bookRoot)
  return { ok: true, status: 'final', skipped: false }
}

/** 清单 docId → relPath（容错：缺文件/未登记 → null）。 */
function lookupRelPath(docId: string, manifestPath: string): string | null {
  try {
    const m = readManifest(manifestPath)
    return m.entries.get(docId)?.path ?? null
  } catch {
    return null
  }
}

/** 从文件名推断章号（`0001-开篇.md` → 1；解析失败 → 0）。 */
function inferChapterFromName(relPath: string): number {
  const base = relPath.split('/').pop() ?? ''
  const m = base.match(/^(\d+)-/)
  return m ? Number(m[1]) : 0
}

function basenameNoExt(relPath: string): string {
  const base = relPath.split('/').pop() ?? ''
  return base.replace(/\.md$/, '')
}