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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { walkMdEach } from '../fs/walk-md.js'
import type { DatabaseSync } from 'node:sqlite'
import type { CheckSectionResult, CheckItem } from './types.js'
import { readLeadHistory } from '../format/read.js'
import { LEAD_TYPES, LEAD_VERBS } from '../format/leads.js'
import { QUOTE_OPEN_LENIENT, QUOTE_CLOSE_LENIENT } from './quotes.js'

/**
 * 账本形式三检。
 *
 * @param db 缓存
 * @param bookRoot 书仓库根（读正文 grep 引文）
 * @param currentChapter 当前定稿章号（章号一致校验用；复检低章时为全书最高定稿章——
 *   未来章基准，T9b。注意与 closureChapter 语义不同）
 * @param enabledTypes 已启用的账本类（只检这些类，#10 第 1 节原则 4）
 * @param declaredLeadIds 声明侧（undefined = 声明未知/无布线，跳过两端闭合，R69-2）
 * @param actualLeadIds 兑现侧（undefined 同上）
 * @param skipBookItems 跳过全书性条目（树红点聚合专用，见 checkLeadsBookItems 头注释）
 * @param closureChapter 两端闭合红项的 chapter 字段归属章（R69-16：默认 currentChapter；
 *   复检低章时 currentChapter 是全书最高定稿章，红项 chapter 若标最高章则在 UI 分组
 *   与误报标记上错指——调用方应传被检章自身章号）
 */
export function checkLeadsForm(
  db: DatabaseSync,
  bookRoot: string,
  currentChapter: number,
  enabledTypes: string[],
  declaredLeadIds?: string[],
  actualLeadIds?: string[],
  skipBookItems = false,
  closureChapter?: number,
): CheckSectionResult {
  const items: CheckItem[] = []
  if (!skipBookItems) items.push(...checkLeadsBookItems(db, bookRoot, currentChapter, enabledTypes))

  // #3 两端闭合（#3 第 7 节）：细纲声明的本章推进 ⟷ 本章实际写入的履历。
  // 二者均由调用方传入（本章履历定稿后才入库，故不查 db）；任一未提供则跳过。
  // ee-P1-3：比对逻辑抽为 leadClosureItems 单一真相源——定稿防吃书闸
  // （document/finalize.ts）与机检复用同一段代码，避免两处口径漂移后闸门漏拦/误拦。
  if (declaredLeadIds !== undefined && actualLeadIds !== undefined) {
    items.push(...leadClosureItems(declaredLeadIds, actualLeadIds, closureChapter ?? currentChapter))
  }

  return { name: '账本形式三检', items }
}

/**
 * 账本三检的「全书性」条目（H-1 拆分，2026-08-21）：章号一致 a/b + 引文命中 + 状态闭合。
 *
 * 这些条目的输入是布线 db + **任意章**的正文（引文 grep 按履历章号直读该章正文），
 * 与被检章自身内容无关——却进每章 report 的 hasRed。树红点章级缓存行只按「本章
 * stat + 纪元」失效，而纪元刻意不含 写作/正文（保住「改 1 章只重查 1 章」），导致
 * 改第 N 章正文补/删引文后其余章的缓存红点陈旧（假红残留或漏红），违反「缓存命中
 * = 全量重算等价」不变量。修复：单章机检端点照旧全量（本函数经 checkLeadsForm 调
 * 用，报告完整）；树红点聚合改为本书一次计算、按「纪元 + 正文目录指纹」单独缓存，
 * 章级缓存行经 skipBookItems 只留章作用域条目（两端闭合：细纲声明 + 本章正文）。
 */
export function checkLeadsBookItems(
  db: DatabaseSync,
  bookRoot: string,
  currentChapter: number,
  enabledTypes: string[],
): CheckItem[] {
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
  // R62-5：章文件定位改一次 walkMdEach 建 章号→路径 查表（首见优先）——此前每新章号
  // 一次 walkMdFind 全树扫，深履历大书 O(章数²)（500 章书最多 500 次全树 readdir）。
  // 惰性建表：无履历章号需求时不发生任何目录扫描（与旧路径「无需求不扫」一致）。
  let chapterPathMap: Map<number, string> | null = null
  const chapterPathOf = (chapter: number): string | null => {
    if (chapterPathMap === null) {
      chapterPathMap = new Map()
      walkMdEach(正文dir, (abs, name) => {
        // 前缀数字 == 章号即登记（补零与否不影响判等）；首见优先保 walkMdFind 找到即停语义
        const n = Number(name.match(/^(\d+)-/)?.[1])
        if (Number.isInteger(n) && !chapterPathMap!.has(n)) chapterPathMap!.set(n, abs)
      })
    }
    return chapterPathMap.get(chapter) ?? null
  }
  const chapterTextCache = new Map<number, string | null>()
  const chapterTextOf = (chapter: number): string | null => {
    if (chapterTextCache.has(chapter)) return chapterTextCache.get(chapter) ?? null
    const path = chapterPathOf(chapter)
    // 低级项（第六轮）：章文件存在但读失败（权限/扫描后瞬删竞态）不崩整个三检——
    // 视同缺失走 lead-evidence-unverifiable 黄项提示作者，而非异常上抛拦截全部检查
    let text: string | null = null
    if (path !== null) {
      try {
        text = readFileSync(path, 'utf-8')
      } catch {
        text = null
      }
    }
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
        // R63-8：匹配走多候选针串任一命中（单针串的内部闭引号会整组 miss，见 evidenceNeedles 头注）；
        // evidenceCore 仅供红项文案展示
        const evidenceCore = extractEvidenceCore(entry.证据)
        const needles = evidenceNeedles(entry.证据)
        if (text === null) {
          // 第五轮：章文件缺失（被删/改名失去数字前缀）时不得静默通过——「防吃书」的
          // 核心红项失明且无任何提示，删章后证据永远无法核验。报黄不报红：正文缺失
          // ≠ 证据不存在（可能是章号写错或文件改名），提示作者处理而非拦截定稿。
          items.push({
            checkId: 'lead-evidence-unverifiable',
            level: 'yellow',
            message: `${id} 履历声称第${entry.章号}章有证据「${evidenceCore ?? entry.证据.slice(0, 20)}」，但找不到该章正文文件——证据无法核验（章被删或改名？）`,
            leadId: id,
            chapter: entry.章号,
          })
        } else if (needles.length > 0 && !needles.some((n) => text.includes(n))) {
          items.push({
            checkId: 'lead-evidence-miss',
            level: 'red',
            message: `${id} 履历引文「${evidenceCore}」在第${entry.章号}章正文未命中`,
            leadId: id,
            chapter: entry.章号,
          })
        } else if (needles.length === 0) {
          // R76-19（二十四轮 B 域）：证据剥引号/清洗后为空（整条证据只是一对空引号或
          // 纯标点）——needles 空使 miss/unverifiable 两不报，引文红闸对该条目静默
          // 失明。改报黄：证据无法核验，请作者补写可检索的引文（假阴性向黄的保守
          // 口径，同章文件缺失分支——不拦截定稿）。
          items.push({
            checkId: 'lead-evidence-unverifiable',
            level: 'yellow',
            message: `${id} 履历证据「${entry.证据.slice(0, 20)}」剥引号后为空——证据无法核验（请补写正文中可检索的引文）`,
            leadId: id,
            chapter: entry.章号,
          })
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

  return items
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

/** 提取证据的核心片段（引号内的内容优先，否则取前 N 字）。export 供 cli/check 当前章引文命中复用同口径。
 *  仅用于展示（红项文案）；正文命中匹配走 evidenceNeedles（R63-8 多候选，见下）。 */
export function extractEvidenceCore(evidence: string): string {
  // 优先取引号内的内容（V-P2-12：统一走 quotes.ts 双体系引号 + 保留 ASCII 直引号——
  // 此前这里只认 ASCII 直引号，中文弯引号/直角引号包裹的证据全部走 slice 兜底，
  // 截断片段致 lead-evidence-miss 误报）。R62-8：宽容字符集收编 quotes.ts 单源导出
  //（证据面宁宽勿漏是设计口径；正文 span 检测不收 ASCII 引号，两口径并存见 quotes.ts）
  const quoted = evidence.match(new RegExp(`[${QUOTE_OPEN_LENIENT}]([^${QUOTE_CLOSE_LENIENT}]{4,})[${QUOTE_CLOSE_LENIENT}]`))
  if (quoted?.[1]) return quoted[1]
  // 否则取前 8 个字符（够 grep）。Y-22（第五十七轮）：短引号证据（如「雪落」3 字，
  // 不满 {4,}）走此兜底——先剥首尾引号再截，带引号字符去 grep 正文会整组 miss
  // （正文写无引号的「雪落」时误报 lead-evidence-miss）
  const stripped = evidence.replace(new RegExp(`^[${QUOTE_OPEN_LENIENT}]|[${QUOTE_CLOSE_LENIENT}]$`, 'g'), '')
  return (stripped || evidence).slice(0, 8)
}

/**
 * R63-8（十一轮）：证据的多候选针串——正文命中「任一候选命中即算」。
 * 此前匹配单针串（extractEvidenceCore 的剥边引号原串），混合短引证据（如
 * 「雪落」无声——引号内 2 字不满 {4,} 走 Y-22 兜底）的内部闭引号留在针串
 * （雪落」无声），正文以无引号形式写同短语时 grep 整组 miss → 误报
 * lead-evidence-miss / 误判「声明未兑现」。候选（去重去空，引号字符集与
 * extractEvidenceCore 同源 quotes.ts 宽容集）：
 * ① 引号内串（长短皆取——Y-22 短引语义补全，长串即原 {4,} 主路径）
 * ② 剥边引号原串（正文连引号一起写的形式）
 * ③ 全剥引号串（混合短引的正身：雪落无声）
 */
export function evidenceNeedles(evidence: string): string[] {
  const inner = new RegExp(`[${QUOTE_OPEN_LENIENT}]([^${QUOTE_CLOSE_LENIENT}]+)[${QUOTE_CLOSE_LENIENT}]`).exec(evidence)?.[1]
  const edgeStripped = evidence.replace(new RegExp(`^[${QUOTE_OPEN_LENIENT}]+|[${QUOTE_CLOSE_LENIENT}]+$`, 'g'), '')
  const allStripped = evidence.replace(new RegExp(`[${QUOTE_OPEN_LENIENT}${QUOTE_CLOSE_LENIENT}]`, 'g'), '')
  return [...new Set([inner, edgeStripped, allStripped].filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()))]
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
 * 主角修炼期每次升级都用，不代表线已收尾——状态闭合不强拦（作者显式
 * 标终态由上面的终态漂移黄项兜底）。其余类 resolve 动词（揭晓/修成/收网…）
 * 语义单一：非成长线的收尾动词默认要求「已收尾」。
 * R73-29（二十一轮）：resolve 动词 + 状态「已放弃」= 揭晓后弃线（先把悬念
 * 揭了、随后整线放弃）是作者显式收口的**合法序列**——此前 `status !== '已收尾'`
 * 一刀切硬拦，作者揭晓后弃线永远挂着 lead-status-open 红项。成长线同步对齐：
 * 突破后弃线同理不再判标错。
 */
const RESOLVE_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].resolve))
const DROP_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].drop))
const OPEN_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].open))
const ADVANCE_VERBS = new Set<string>(LEAD_TYPES.flatMap((t) => LEAD_VERBS[t].advance))
const GROWTH_RESOLVE_VERBS = new Set<string>(LEAD_VERBS.成长线.resolve)

function checkStatusClosure(lastVerb: string, status: string, leadType?: string): boolean {
  // 成长线的 resolve 动词（突破/跨层/跃迁）是常态化升级，任何状态下都不强拦
  if (leadType === '成长线' && GROWTH_RESOLVE_VERBS.has(lastVerb)) {
    return false
  }
  if (DROP_VERBS.has(lastVerb) && status !== '已放弃') return true
  // R73-29：resolve +「已收尾/已放弃」都算闭合；其余状态（如进行中）仍要求翻转为已收尾
  if (RESOLVE_VERBS.has(lastVerb) && status !== '已收尾' && status !== '已放弃') return true
  return false
}
