/**
 * 账本形式三检 —— 依据 #3 第 7 节 + #10 第 2 节项 1（🔴 红）。
 *
 * 三检（零 token 机检，全七类覆盖，定稿前校验）：
 * 1. 章号一致：履历章号 == 写入它的那次定稿章号（回填除外）
 * 2. 引文命中：履历的章内证据须在该章正文 grep 命中
 * 3. 两端闭合：细纲声明的本章变动 ⟷ 定稿实际写入的履历
 *
 * 状态闭合（#3 第 5 节）：状态 ⟷ 履历末条动词一致。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CheckSectionResult, CheckItem } from './types.js'
import { readLeadHistory } from '../format/read.js'
import { LEAD_TYPES, LEAD_VERBS } from '../format/leads.js'
import { QUOTE_OPEN, QUOTE_CLOSE } from './quotes.js'

/**
 * 账本形式三检。
 *
 * @param db 缓存
 * @param bookRoot 书仓库根（读正文 grep 引文）
 * @param currentChapter 当前定稿章号（章号一致校验用）
 * @param enabledTypes 已启用的账本类（只检这些类，#10 第 1 节原则 4）
 */
export function checkLeadsForm(
  db: DatabaseSync,
  bookRoot: string,
  currentChapter: number,
  enabledTypes: string[],
  declaredLeadIds?: string[],
  actualLeadIds?: string[],
): CheckSectionResult {
  const items: CheckItem[] = []

  // 取所有已启用类的 open 条目
  const placeholders = enabledTypes.map(() => '?').join(',')
  const leads = db.prepare(
    `SELECT id, type, title, status FROM leads WHERE type IN (${placeholders})`,
  ).all(...enabledTypes) as Record<string, unknown>[]

  const 正文dir = join(bookRoot, '写作', '正文')

  // Z-P2-12：章文件解析 + 正文读取按章号缓存（本次三检作用域）。
  // 此前每条履历证据都递归扫目录 + 整章重读，O(履历数×章数) IO——大书三检显著变慢；
  // 不做跨调用缓存：定稿间正文会变，过期正文会漏报 lead-evidence-miss。
  const chapterPathCache = new Map<number, string | null>()
  const chapterTextCache = new Map<number, string | null>()
  const chapterTextOf = (chapter: number): string | null => {
    if (chapterTextCache.has(chapter)) return chapterTextCache.get(chapter) ?? null
    if (!chapterPathCache.has(chapter)) {
      chapterPathCache.set(chapter, findChapterFile(正文dir, chapter))
    }
    const path = chapterPathCache.get(chapter) ?? null
    const text = path !== null ? readFileSync(path, 'utf-8') : null
    chapterTextCache.set(chapter, text)
    return text
  }

  for (const lead of leads) {
    const id = lead['id'] as string
    const history = readLeadHistory(db, id)

    let prevChapter = 0 // 章号单调校验（履历按 seq 排序，非回填章号应不减）
    for (const entry of history) {
      // #1 章号一致 a：非回填行的章号须 ≤ currentChapter（不能凭空声称未来章）
      if (!entry.回填 && entry.章号 > currentChapter) {
        items.push({
          checkId: 'lead-chapter-future',
          level: 'red',
          message: `${id} 履历声称第${entry.章号}章，但当前只定稿到第${currentChapter}章（凭空声称未来章）`,
          leadId: id,
          chapter: entry.章号,
        })
      }

      // #1 章号一致 b：非回填履历章号随 seq 不减（乱序 = 章号写错的强信号）
      if (!entry.回填 && entry.章号 < prevChapter) {
        items.push({
          checkId: 'lead-chapter-disorder',
          level: 'red',
          message: `${id} 履历章号乱序：第${entry.章号}章出现在第${prevChapter}章之后`,
          leadId: id,
          chapter: entry.章号,
        })
      }
      if (!entry.回填) prevChapter = Math.max(prevChapter, entry.章号)

      // #2 引文命中：证据须在该章正文 grep 命中
      if (!entry.回填 && entry.证据) {
        const text = chapterTextOf(entry.章号)
        if (text) {
          // 取引号内的核心片段 grep（#3 第 4 节：章内证据尽量是正文原文）
          const evidenceCore = extractEvidenceCore(entry.证据)
          if (evidenceCore && !text.includes(evidenceCore)) {
            items.push({
              checkId: 'lead-evidence-miss',
              level: 'red',
              message: `${id} 履历引文「${evidenceCore}」在第${entry.章号}章正文未命中`,
              leadId: id,
              chapter: entry.章号,
            })
          }
        }
      }
    }

    // 状态闭合（#3 第 5 节）：状态 ⟷ 履历末条动词
    if (history.length > 0) {
      const lastEntry = history[history.length - 1]!
      const status = lead['status'] as string
      const statusMismatch = checkStatusClosure(lastEntry.动词, status, lead['type'] as string)
      if (statusMismatch) {
        items.push({
          checkId: 'lead-status-open',
          level: 'red',
          message: `${id} 状态「${status}」与履历末条动词「${lastEntry.动词}」不一致`,
          leadId: id,
        })
      } else if (
        (status === '已收尾' || status === '已放弃') &&
        (OPEN_VERBS.has(lastEntry.动词) || ADVANCE_VERBS.has(lastEntry.动词))
      ) {
        // RB-KN-P2-9：反向漂移——状态已标终态但末条足迹仍是开端/推进动词。原先只检
        // 正向（末条收尾 → 状态须翻转），账本被标「已收尾」后又推进的状态漂移无检测。
        // 报黄不报红：作者显式改状态收口是合法场景，提示而非拦截。
        items.push({
          checkId: 'lead-status-drift',
          level: 'yellow',
          message: `${id} 状态已标「${status}」但履历末条仍是推进动词「${lastEntry.动词}」——若为作者显式收口请忽略，否则状态与足迹已漂移`,
          leadId: id,
        })
      }
    }
  }

  // #3 两端闭合（#3 第 7 节）：细纲声明的本章推进 ⟷ 本章实际写入的履历。
  // 二者均由调用方传入（本章履历定稿后才入库，故不查 db）；任一未提供则跳过。
  // ee-P1-3：比对逻辑抽为 leadClosureItems 单一真相源——定稿防吃书闸
  // （document/finalize.ts）与机检复用同一段代码，避免两处口径漂移后闸门漏拦/误拦。
  if (declaredLeadIds !== undefined && actualLeadIds !== undefined) {
    items.push(...leadClosureItems(declaredLeadIds, actualLeadIds, currentChapter))
  }

  return { name: '账本形式三检', items }
}

/**
 * #3 两端闭合（#3 第 7 节）比对：细纲声明的本章推进 ⟷ 本章实际写入的履历。
 * 声明了没做（lead-declared-not-done）/ 做了没声明（lead-done-not-declared）各成一条红。
 * ee-P1-3 从 checkLeadsForm 抽出为导出纯函数（逻辑逐字保留）：
 * 手工/批量定稿的防吃书闸只拦这两条账本结构红，与机检共享同一实现作单一真相源。
 */
export function leadClosureItems(
  declaredLeadIds: string[],
  actualLeadIds: string[],
  currentChapter: number,
): CheckItem[] {
  const items: CheckItem[] = []
  const declared = new Set(declaredLeadIds)
  const actual = new Set(actualLeadIds)
  // 声明了没做
  for (const id of declared) {
    if (!actual.has(id)) {
      items.push({
        checkId: 'lead-declared-not-done',
        level: 'red',
        message: `细纲声明本章推进 ${id}，但本章未写入其履历（声明了没做）`,
        leadId: id,
        chapter: currentChapter,
      })
    }
  }
  // 做了没声明
  for (const id of actual) {
    if (!declared.has(id)) {
      items.push({
        checkId: 'lead-done-not-declared',
        level: 'red',
        message: `本章为 ${id} 写入履历，但细纲未声明推进它（做了没声明）`,
        leadId: id,
        chapter: currentChapter,
      })
    }
  }
  return items
}

/** 找某章的正文文件（写作/正文/<章号>-*.md，章号补零与否均匹配）。
 *  递归扫描含卷子目录（写作/正文/第一卷/...）—— scaffold 默认即卷布局，
 *  非递归会让引文命中检查在默认布局下整体跳过（防吃书核心环节失效）。 */
function findChapterFile(正文dir: string, chapter: number): string | null {
  return findChapterFileRecursive(正文dir, chapter)
}

function findChapterFileRecursive(dir: string, chapter: number): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      if (e.name.startsWith('._')) continue
      if (e.isDirectory()) {
        const found = findChapterFileRecursive(join(dir, e.name), chapter)
        if (found) return found
      } else if (e.isFile() && e.name.endsWith('.md')) {
        // 解析文件名前缀数字 == chapter，不受补零（0152 vs 152）影响
        if (Number(e.name.match(/^(\d+)-/)?.[1]) === chapter) return join(dir, e.name)
      }
    }
    return null
  } catch {
    return null
  }
}

/** 提取证据的核心片段（引号内的内容优先，否则取前 N 字）。export 供 cli/check 当前章引文命中复用同口径。 */
export function extractEvidenceCore(evidence: string): string {
  // 优先取引号内的内容（V-P2-12：统一走 quotes.ts 双体系引号 + 保留 ASCII 直引号——
  // 此前这里只认 ASCII 直引号，中文弯引号/直角引号包裹的证据全部走 slice 兜底，
  // 截断片段致 lead-evidence-miss 误报）
  const quoted = evidence.match(new RegExp(`[${QUOTE_OPEN}"]([^${QUOTE_CLOSE}"]{4,})[${QUOTE_CLOSE}"]`))
  if (quoted?.[1]) return quoted[1]
  // 否则取前 8 个字符（够 grep）
  return evidence.slice(0, 8)
}

/**
 * 状态闭合校验（#3 第 5 节）：
 * 末条动词是收尾类 → 状态须「已收尾」
 * 末条动词是放弃类 → 状态须「已放弃」
 *
 * 动词集合单源派生自 LEAD_VERBS，避免硬编码漂移
 * （曾因硬编码漏掉成长线「跨层/跃迁」导致状态闭合误判）。
 *
 * 成长线特判：resolve 动词（突破/跨层/跃迁）是**常态化升级动词**，
 * 主角修炼期每次升级都用，不代表线已收尾——只有作者显式标「已收尾」
 * 才算闭合。否则卷末阶段性突破会被误报「状态此刻应已收尾」。
 * 其余类 resolve 动词（揭晓/修成/收网…）语义单一，维持原约束。
 */
const RESOLVE_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].resolve))
const DROP_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].drop))
const OPEN_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].open))
const ADVANCE_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].advance))
const GROWTH_RESOLVE_VERBS = new Set<string>(LEAD_VERBS.成长线.resolve)

function checkStatusClosure(lastVerb: string, status: string, leadType?: string): boolean {
  // 成长线的 resolve 动词（突破/跨层/跃迁）是常态化升级，末条「进行中」合理；
  // 但若作者显式标「已收尾/已放弃」，仍要求动词匹配（防作者标错状态）。
  if (leadType === '成长线' && GROWTH_RESOLVE_VERBS.has(lastVerb)) {
    if (status === '已收尾') return false
    if (status === '已放弃') return true
    return false
  }
  if (RESOLVE_VERBS.has(lastVerb) && status !== '已收尾') return true
  if (DROP_VERBS.has(lastVerb) && status !== '已放弃') return true
  return false
}
