/**
 * 定稿时账本履历回写（W-P1-3 右端闭环 + 决策 2「一并补齐履历回写，放 finalize 回写」）。
 *
 * 流程：作者/AI 写完章 → AI 生成 工作区/账本推进.md（AI 草拟，作者可在编辑器确认/修改）
 * → 定稿（finalizeRevision）→ 本模块把「已确认」的账本推进逐条回写布线条目 履历 段
 * → 清空 账本推进.md（归档设计 定稿操作-设计方案.md:135「定稿时清理账本推进.md」）。
 *
 * X-P2-6：批量连写下各章草稿按章归档（工作区/.账本推进暂存/第N章.md）——回收时
 * 主文件（章节标签匹配或无标签旧格式）与本章归档一并读取，其余章的待确认内容不动。
 * X-P2-8：resolve/drop 动词落库时同步派生条目 状态（与 checkStatusClosure 口径对齐），
 * 防「履历末条揭晓 + 状态进行中」自产 lead-status-open 红阻断后续章自愈。
 *
 * 幂等：定稿 skipped（指纹未变）时不重复回写；回写后再定稿同一章（内容已改）时
 * 账本推进.md 已被清空 → 无新条目 → 天然不重复追加。
 */
import { existsSync, rmSync } from 'node:fs'
import { atomicWriteFile } from '../fs/atomic.js'
import { join } from 'node:path'
import { readLeadDir, writeLead, LEAD_TYPES, LEAD_VERBS } from '../format/leads.js'
import { readLeadUpdatesAt, readLeadUpdateChapterTag, type ChapterLeadUpdate } from '../check/lead-updates.js'

/** 账本推进文件路径（与 check/lead-updates.ts 读取常量一致） */
export const LEAD_UPDATES_FILE = '工作区/账本推进.md'

/** 批量归档目录（与 process/lead-update-draft.ts 常量一致） */
export const LEAD_UPDATES_ARCHIVE_DIR = '工作区/.账本推进暂存'

/**
 * 把已确认的账本推进回写布线履历（找到对应条目按 编号 追加履历行），
 * 成功回写后清空本章 账本推进.md / 本章归档。
 *
 * @param bookRoot 书仓库根
 * @param chapterNo 定稿章号（履历行「第N章」）
 * @returns 回写条数（无账本推进文件 → 0）
 */
export function applyLeadUpdates(bookRoot: string, chapterNo: number): number {
  // X-P2-6：主文件（标签匹配本章 / 无标签旧格式）+ 本章归档双源回收；
  // 主文件载有其他章待确认内容（批量连写）时不动它。
  const mainPath = join(bookRoot, LEAD_UPDATES_FILE)
  const mainTag = readLeadUpdateChapterTag(mainPath)
  const mainIsThisChapter = mainTag === null || mainTag === chapterNo
  const archivePath = join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR, `第${chapterNo}章.md`)
  const updates: ChapterLeadUpdate[] = [
    ...(mainIsThisChapter ? readLeadUpdatesAt(mainPath) : []),
    ...readLeadUpdatesAt(archivePath),
  ]
  if (updates.length === 0) return 0

  // 布线目录：基础类在 布线/{类}，关系线在 大纲/关系线（与 cache/rebuild.ts 同口径）
  const dirs: string[] = []
  for (const typeName of LEAD_TYPES) {
    const root = typeName === '关系线' ? join(bookRoot, '大纲') : join(bookRoot, '布线')
    dirs.push(join(root, typeName))
  }

  let applied = 0
  for (const u of updates) {
    const leadFile = findLeadFile(dirs, u.leadId)
    if (!leadFile) continue // 编号查无此线（作者手改/线已删）→ 跳过不崩
    const { lead } = leadFile
    // 去重：同 章号+动词+证据 已在履历中（内容未变重复定稿）→ 跳过
    const dup = lead.履历.some(
      (e) => e.章号 === chapterNo && e.动词 === u.动词 && e.证据 === u.证据,
    )
    if (dup) continue
    lead.履历.push({ 章号: chapterNo, 动词: u.动词, 证据: u.证据 })
    // X-P2-8：按动词派生状态（仅 进行中 → 终态；作者显式标注的终态/其他值不覆盖）。
    // 成长线 resolve（突破/跨层/跃迁）是常态化升级，保持 进行中（与 checkStatusClosure 特判一致）。
    const leadType = u.leadId.split('-')[0] as keyof typeof LEAD_VERBS
    const verbs = LEAD_VERBS[leadType]
    if (verbs && lead.状态 === '进行中') {
      if (verbs.drop.includes(u.动词)) lead.状态 = '已放弃'
      else if (verbs.resolve.includes(u.动词) && leadType !== '成长线') lead.状态 = '已收尾'
    }
    writeLead(leadFile.filePath, lead)
    applied++
  }

  // 回写完成后清空本章源（作者已确认并落库，防重复追加）；其他章待确认内容保持原样
  if (applied > 0) {
    if (mainIsThisChapter && existsSync(mainPath)) {
      try {
        // dd-P3：统一原子写（目标虽是清空，也走 tmp+rename 消裸写窗口）
        // ee-P1-6：对齐账本写点 fsync 纪律（掉电回退由履历去重兜底，fsync 消除该窗口）
        atomicWriteFile(mainPath, '', { fsync: true })
      } catch {
        /* 清空失败不阻断定稿主流程 */
      }
    }
    if (existsSync(archivePath)) {
      try {
        rmSync(archivePath, { force: true })
      } catch {
        /* 归档清理失败不阻断定稿主流程 */
      }
    }
  }
  return applied
}

/** 按 编号 在候选目录中找账本条目文件（无则 null）。 */
function findLeadFile(dirs: string[], leadId: string): { filePath: string; lead: import('../format/types.js').Lead } | null {
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const { leads } = readLeadDir(dir)
    const hit = leads.find((l) => l.编号 === leadId)
    if (hit?._path) {
      return { filePath: hit._path, lead: hit }
    }
  }
  return null
}
