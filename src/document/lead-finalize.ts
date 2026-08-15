/**
 * 定稿时账本履历回写（W-P1-3 右端闭环 + 决策 2「一并补齐履历回写，放 finalize 回写」）。
 *
 * 流程：作者/AI 写完章 → AI 生成 工作区/账本推进.md（AI 草拟，作者可在编辑器确认/修改）
 * → 定稿（finalizeRevision）→ 本模块把「已确认」的账本推进逐条回写布线条目 履历 段
 * → 清空 账本推进.md（归档设计 定稿操作-设计方案.md:135「定稿时清理账本推进.md」）。
 *
 * 幂等：定稿 skipped（指纹未变）时不重复回写；回写后再定稿同一章（内容已改）时
 * 账本推进.md 已被清空 → 无新条目 → 天然不重复追加。
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLeadDir, writeLead, LEAD_TYPES } from '../format/leads.js'
import { readChapterLeadUpdates } from '../check/lead-updates.js'

/** 账本推进文件路径（与 check/lead-updates.ts 读取常量一致） */
export const LEAD_UPDATES_FILE = '工作区/账本推进.md'

/**
 * 把已确认的账本推进回写布线履历（找到对应条目按 编号 追加履历行），
 * 成功回写后清空 账本推进.md。
 *
 * @param bookRoot 书仓库根
 * @param chapterNo 定稿章号（履历行「第N章」）
 * @returns 回写条数（无账本推进文件 → 0）
 */
export function applyLeadUpdates(bookRoot: string, chapterNo: number): number {
  const updates = readChapterLeadUpdates(bookRoot)
  if (updates.length === 0) {
    // 无账本推进文件/空 → 无事可做（不清空，避免误删作者手写内容）
    return 0
  }

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
    writeLead(leadFile.filePath, lead)
    applied++
  }

  // 回写完成后清空 账本推进.md（作者已确认并落库，防重复追加）
  const p = join(bookRoot, LEAD_UPDATES_FILE)
  if (existsSync(p)) {
    try {
      writeFileSync(p, '', 'utf-8')
    } catch {
      /* 清空失败不阻断定稿主流程 */
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
