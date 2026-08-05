/**
 * 定稿确认（P1：改稿确认，revision → final）。
 *
 * 作者在 app 里编辑正文/设定文件 → 保存（git 变脏 → revision 态）
 * → 点「定稿」→ git add + commit 精确提交该文件 → git 干净 → 派生回 final。
 *
 * 复用 git/exec.addCommit（commit 消息沿用 `ch:<章号> <标题>` 约定，
 * findChapterCommit 依赖此前缀反查定稿 commit）。
 */
import { join } from 'node:path'
import { addCommit } from '../git/exec.js'
import { readChapter } from '../format/chapters.js'
import { readManifest } from './manifest.js'
import { invalidateTreeIndex } from './tree.js'
import { collectDirtyFiles } from './status.js'
import { roleOf } from './layout.js'

export type FinalizeOutcome =
  | { ok: true; status: 'final'; skipped: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_DRAFT_REGION' | 'GIT_FAIL'; error: string }

/**
 * 定稿确认：对正文/设定等区一个 revision 态文件做 git commit → 回 final。
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

  // 草稿校验：草稿（写作/草稿/）不可定稿（草稿入卷属 P2，不在本阶段）
  const role = roleOf(relPath)
  if (role === 'draft') {
    return { ok: false, code: 'NOT_DRAFT_REGION', error: '仅正文/设定等文档可定稿（草稿入卷功能开发中）' }
  }

  // 从正文 frontmatter 取章号 + 标题（commit message 用）；解析失败从文件名推断
  const absPath = join(bookRoot, relPath)
  const rd = readChapter(absPath)
  const chapterNo = rd.ok ? rd.chapter.章号 : inferChapterFromName(relPath)
  const title = rd.ok && rd.chapter.标题 ? rd.chapter.标题 : basenameNoExt(relPath)
  const msg = `ch:${String(chapterNo).padStart(4, '0')} ${title}`

  // 幂等：git 干净（已定稿）→ skipped，不重复 commit（避免 addCommit 报 nothing to commit）
  if (!collectDirtyFiles(bookRoot).has(relPath)) {
    return { ok: true, status: 'final', skipped: true }
  }

  // 精确 commit 该文件（只定稿当前章，不连带其他脏文件）
  const c = addCommit(bookRoot, msg, [relPath])
  if (!c.ok) return { ok: false, code: 'GIT_FAIL', error: c.humanMsg }

  // 树缓存失效（前端重拉树能看到 final 态）
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