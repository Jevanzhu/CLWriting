/**
 * 账本推进声明解析 —— 账本 CLI 接缝修复（兑现层）。
 *
 * `工作区/账本推进.md` 是 AI 写完正文后声明的「本章实际写入的履历行」，与履历段同构
 * （去掉「第N章」——章号隐含为当前定稿章号）：
 *
 *   - 成长线-001 起步：林开脉，踏入炼气一层。
 *   - 设定线-001 树立：灵脉体系——天地灵气分九品。
 *
 * 解析为 {leadId, 动词, 证据}[]，供：
 * - check：actualLeadIds（两端闭合右侧，证据命中草稿正文才算兑现）
 * - finalize：leadUpdates（补当前定稿章号后落盘履历，#13）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 本章一条账本推进声明（章号在落盘时由定稿章号补齐） */
export interface ChapterLeadUpdate {
  leadId: string
  动词: string
  证据: string
}

/**
 * 解析 `工作区/账本推进.md`（无文件/空 → []）。
 *
 * 行格式：`- <编号> <动词>：<证据>`（冒号支持全角/半角；非列表行忽略）。
 */
export function readChapterLeadUpdates(workDir: string): ChapterLeadUpdate[] {
  const p = join(workDir, '账本推进.md')
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf-8')
  const out: ChapterLeadUpdate[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('-')) continue
    // - <编号> <动词>：<证据>
    const m = line.match(/^-\s*(\S+)\s+([^\s:：]+)[:：]\s*(.+)$/)
    if (m) {
      out.push({ leadId: m[1]!.trim(), 动词: m[2]!.trim(), 证据: m[3]!.trim() })
    }
  }
  return out
}
