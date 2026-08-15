/**
 * 账本推进声明解析 —— 账本 CLI 接缝修复（兑现层）。
 * （P1-8 架构下沉：从 src/process/lead-updates.ts 移入 check 域，机检账本数据源归位）
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
import { extractEvidenceCore } from './leads.js'

/** 本章一条账本推进声明（章号在落盘时由定稿章号补齐） */
export interface ChapterLeadUpdate {
  leadId: string
  动词: string
  证据: string
}

/**
 * 解析 `工作区/账本推进.md`（无文件/空/读失败 → []；X-P2-5 读失败按无推进降级）。
 *
 * 行格式：`- <编号> <动词>：<证据>`（冒号支持全角/半角；非列表行忽略）。
 * 首行约定 `# 第N章 账本推进`（X-P2-6 章节标签，解析时忽略；旧文件无标签同样兼容）。
 */
export function readChapterLeadUpdates(bookRoot: string): ChapterLeadUpdate[] {
  const p = join(bookRoot, '工作区', '账本推进.md')
  return readLeadUpdatesAt(p)
}

/** 读指定路径的账本推进文件（无文件/空/读失败 → []）。 */
export function readLeadUpdatesAt(absPath: string): ChapterLeadUpdate[] {
  if (!existsSync(absPath)) return []
  let text: string
  try {
    text = readFileSync(absPath, 'utf-8')
  } catch {
    return [] // X-P2-5：读失败（并发删/权限）按无推进降级，不阻断机检/定稿
  }
  return parseLeadUpdateLines(text)
}

/** 解析账本推进文本（`- <编号> <动词>：<证据>` 行；非列表行忽略）。 */
export function parseLeadUpdateLines(text: string): ChapterLeadUpdate[] {
  const out: ChapterLeadUpdate[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('-')) continue
    // - <编号> <动词>：<证据>
    const m = line.match(/^-\s*(\S+)\s+([^\s:：]+)[:：]\s*(.+)$/)
    if (m) {
      const evidence = m[3]!.trim()
      if (!evidence) continue
      out.push({ leadId: m[1]!.trim(), 动词: m[2]!.trim(), 证据: evidence })
    }
  }
  return out
}

/** 读账本推进文件的章节标签（首行 `# 第N章 …`；无标签/解析失败 → null）。 */
export function readLeadUpdateChapterTag(absPath: string): number | null {
  if (!existsSync(absPath)) return null
  try {
    const first = readFileSync(absPath, 'utf-8').split('\n', 1)[0] ?? ''
    const m = first.match(/^#\s*第(\d+)章/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** 账本证据核心必须非空且在正文命中，避免 includes('') 把空证据误判为兑现。 */
export function leadEvidenceMatchesBody(body: string, evidence: string): boolean {
  const core = extractEvidenceCore(evidence).trim()
  return core.length > 0 && body.includes(core)
}