/**
 * 章纲孤儿/复号判据单源（证据 = 并入引用 ∪ 回收站正文章号集）。
 *
 * 背景：合并软删源章后其章纲留盘则成「无主纲」（无一致性检查覆盖）；章号复用
 * （取号按正文 max+1，被删章号腾出）会让旧纲被新章按 fm 章号静默认领。判据 =
 * 章纲章号 ∈ 并入引用（mergedIntoMap）∪ 回收站 role='chapter' 条目章号（含删除章
 * 留下的痕迹），再配「无存活同号正文」守卫——预先写好、章未写的计划前置章纲
 * 无任何证据，恒判非孤儿（零误报优先）。
 *
 * kind 两分：orphan（无存活宿主，evidence 记去向）与 reused（复号有宿主——盘上旧纲
 * 可能被新章静默认领）。消费口径：orphan+merged → 挂合并目标章的机检黄项；
 * orphan+trashed → 结构报表（无主纲）；reused → 复号提示项（可误报灰显）；
 * outlineTrashExempt → 回收站能力例外（仅无主章纲放行软删，见 service.ts）。
 *
 * 章纲身份章号 = fm 章号 ?? 文件名数字前缀（与 locateChapterOutline 三口径同精神：
 * 改名/裸文件形态都认）。存活判据取保守 union（文件名号 ∪ fm 号）——任一轨在盘即算
 * 存活，宁漏勿错（两轨失配另有专门闸，见 chapterNumberMismatches）。
 */
import { existsSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { chapterNoFromName, isMdFileName } from '../format/filename.js'
import { parseChapterNo, readChapterDir } from '../format/chapters.js'
import { mergedIntoMap } from '../format/chapter-lookup.js'
import { splitFrontMatter, parseFlat } from '../format/frontmatter.js'
import { readMdTextCached } from '../fs/md-text-cache.js'
import { walkMdEach } from '../fs/walk-md.js'
import { normalizeWinSeparators, safeManifestPath } from '../fs/safe-path.js'
import { listTrash, type TrashEntry } from './trash.js'

/** 章纲目录（相对 bookRoot）——locateChapterOutline 同源字面量（三口径定位单源）。 */
const OUTLINE_DIR_REL = '大纲/章纲'
const BODY_DIR_REL = '写作/正文'

/** 清单/回收站条目路径 → 章号（剥 .md 茎后走 chapterNoFromName 单源）。 */
function chapterNoFromEntryPath(relPath: string): number | null {
  const base = basename(relPath)
  return chapterNoFromName(isMdFileName(base) ? base.slice(0, -3) : base)
}

/** 回收站正文章号 → 条目（同章号多条取最新 trashedAt）。 */
function trashedChapterEntries(bookRoot: string): Map<number, TrashEntry> {
  const map = new Map<number, TrashEntry>()
  for (const e of listTrash(bookRoot)) {
    if (e.role !== 'chapter') continue
    const no = chapterNoFromEntryPath(e.originalPath)
    if (no === null) continue
    const prev = map.get(no)
    if (prev === undefined || e.trashedAt > prev.trashedAt) map.set(no, e)
  }
  return map
}

/** 存活正文章号（保守 union）：文件名数字前缀 ∪ fm 章号。 */
function liveChapterNos(bookRoot: string): Set<number> {
  const out = new Set<number>()
  const bodyDir = join(bookRoot, BODY_DIR_REL)
  if (!existsSync(bodyDir)) return out
  walkMdEach(bodyDir, (_fp, name) => {
    const n = chapterNoFromName(name)
    if (n !== null) out.add(n)
  })
  for (const ch of readChapterDir(bodyDir).chapters) out.add(ch.章号)
  return out
}

/** 章纲身份章号：fm 章号 ?? 文件名数字前缀（读失败按文件名口径兜底）。 */
function outlineChapterNo(absPath: string): number | null {
  const raw = readMdTextCached(absPath)
  if (raw !== null) {
    const sp = splitFrontMatter(raw)
    if (sp) {
      const no = parseChapterNo(parseFlat(sp.fmRaw).get('章号'))
      if (no !== null) return no
    }
  }
  const base = basename(absPath)
  return chapterNoFromName(isMdFileName(base) ? base.slice(0, -3) : base)
}

/** 盘上章纲的判定结论。 */
export interface OutlineFinding {
  /** 章纲文件路径（相对 bookRoot，分隔符归一——报表/黄项展示用）。 */
  outlinePath: string
  /** 章纲身份章号（fm 章号 ?? 文件名数字前缀）。 */
  chapterNo: number
  /** orphan = 无存活宿主；reused = 复号有宿主（盘上纲可能属于旧章）。 */
  kind: 'orphan' | 'reused'
  /** 去向证据：merged = 章号在目标章 fm 并入 引用；trashed = 回收站有该章号正文条目。 */
  evidence: 'merged' | 'trashed'
  /** evidence==='merged'：吸收该章号的目标章正文绝对路径（与 ChapterMeta._path 同源可直比）。 */
  mergedIntoPath?: string
  /** evidence==='trashed'：被删章正文在回收站的原路径（相对 bookRoot）。 */
  trashedFromPath?: string
}

/** 全书章纲扫描：大纲/章纲/ 逐个判定，无证据（计划前置纲）不产出。
 *  常态书早退（无并入引用且回收站无正文章目不扫纲）——机检逐章调用零成本。 */
export function scanOutlineFindings(bookRoot: string): OutlineFinding[] {
  const merged = mergedIntoMap(bookRoot)
  const trashed = trashedChapterEntries(bookRoot)
  if (merged.size === 0 && trashed.size === 0) return []
  const outlineDir = join(bookRoot, OUTLINE_DIR_REL)
  if (!existsSync(outlineDir)) return []
  let live: Set<number> | null = null
  const findings: OutlineFinding[] = []
  walkMdEach(outlineDir, (abs) => {
    const no = outlineChapterNo(abs)
    if (no === null) return // 无身份章号：不可判，不猜
    const mergedIntoPath = merged.get(no)
    if (mergedIntoPath !== undefined) {
      live ??= liveChapterNos(bookRoot)
      // 并入号与存活正文并存 = ①后崩溃半成态（源章未软删）——由 structurePending
      // 报，此处不重复：源章还在，纲不是孤儿
      if (live.has(no)) return
      findings.push({
        outlinePath: normalizeWinSeparators(relative(bookRoot, abs)),
        chapterNo: no,
        kind: 'orphan',
        evidence: 'merged',
        mergedIntoPath,
      })
      return
    }
    const entry = trashed.get(no)
    if (entry === undefined) return // 计划前置章纲：零误报
    live ??= liveChapterNos(bookRoot)
    findings.push({
      outlinePath: normalizeWinSeparators(relative(bookRoot, abs)),
      chapterNo: no,
      kind: live.has(no) ? 'reused' : 'orphan',
      evidence: 'trashed',
      trashedFromPath: entry.originalPath,
    })
  })
  return findings
}

/** 回收站能力例外判据（service.ts lookupTrashTarget 消费，调用方已确 role='chapter-outline'）：
 *  章纲章号有证据（并入引用 ∪ 回收站正文章号集）且无存活同号正文 = 无主章纲，放行软删。
 *  存活正文的纲不放行（系统文档不可删的设计不因本例外放宽）。 */
export function outlineTrashExempt(bookRoot: string, outlineRelPath: string): boolean {
  const abs = safeManifestPath(bookRoot, outlineRelPath)
  if (abs === null || !existsSync(abs)) return false
  const no = outlineChapterNo(abs)
  if (no === null) return false
  if (!mergedIntoMap(bookRoot).has(no) && !trashedChapterEntries(bookRoot).has(no)) return false
  return !liveChapterNos(bookRoot).has(no)
}

/** 回收站按章号找章纲条目（undo 对称还原的兜底定位：事件未携带 id 的旧载荷/崩溃形态）。
 *  preferBasename（源章正文 basename）命中者优先，各自择最新 trashedAt——短篇纲与
 *  正文同名，长篇纲不同名时自然落到全章号择最新。 */
export function findOutlineTrashEntry(bookRoot: string, chapterNo: number, preferBasename?: string): TrashEntry | null {
  let best: TrashEntry | null = null
  let bestPreferred: TrashEntry | null = null
  for (const e of listTrash(bookRoot)) {
    if (e.role !== 'chapter-outline') continue
    if (chapterNoFromEntryPath(e.originalPath) !== chapterNo) continue
    if (best === null || e.trashedAt > best.trashedAt) best = e
    if (preferBasename !== undefined && basename(e.originalPath) === preferBasename) {
      if (bestPreferred === null || e.trashedAt > bestPreferred.trashedAt) bestPreferred = e
    }
  }
  return bestPreferred ?? best
}
