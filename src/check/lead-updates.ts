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
import { evidenceNeedles } from './leads.js'
import { ATX_HEADING_RE, headingEndsSection } from '../format/leads.js'
import { log } from '../log/index.js'

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
/** 读指定路径的账本推进文件（无文件/空/读失败 → []）。
 *  R30-17（三十轮）：原「整文件视角」封装 readChapterLeadUpdates（bookRoot → 主文件）
 *  零生产调用（R66-15 登记的死代码）已删除——生产链统一走 readChapterUpdatesForChapter
 *  （ff-P1-1 单源，主文件+归档两源），文件级读取统一走本函数。
 *  R31-3（三十一轮）：读失败降级语义由调用方按需选择——降级敏感场景（两端闭合判定）
 *  请改走 readLeadUpdatesAtChecked（null = 读失败 ≠ 无推进）。本函数维持 X-P2-5 的 []
 *  兜底口径，供对「读失败=无推进」不敏感的既有调用方（履历回写等）零改动沿用。 */
export function readLeadUpdatesAt(absPath: string): ChapterLeadUpdate[] {
  return readLeadUpdatesAtChecked(absPath) ?? []
}

/**
 * R31-3（三十一轮）：读失败三态版 readLeadUpdatesAt——区分「文件不存在」（→ []，
 * 语义 = 明确无推进）与「文件在但读失败」（→ null，权限/瞬态占用等，推进清单未知）。
 * 此前读失败按 [] 与「无推进」混同：声明侧有推进而兑现侧读失败时，闭合比对把
 * 「未知」当「已声明未兑现」产 lead-declared-not-done 红，经 LEAD_GATE 硬阻断定稿
 * （把瞬态故障当作者过错）。对齐 outline-leads.ts 声明侧 R70-15 的 known:false 口径
 * （读失败跳过闭合，防假红硬阻断）；调用方拿到 null 须跳过闭合并产黄降级（fail-noisy）。
 */
export function readLeadUpdatesAtChecked(absPath: string): ChapterLeadUpdate[] | null {
  if (!existsSync(absPath)) return []
  let text: string
  try {
    text = readFileSync(absPath, 'utf-8')
  } catch {
    return null // R31-3：读失败（并发删/权限）→ null = 推进清单未知，不冒充「无推进」
  }
  return parseLeadUpdateLines(text)
}

/** R31-3（三十一轮）：本章推进读取结果——updates 为可用清单；unreadable = true 表示
 *  至少一个数据源（主文件/归档）存在但读失败，清单不完整，调用方不得据其做闭合判定。 */
export interface ChapterUpdatesResult {
  updates: ChapterLeadUpdate[]
  unreadable: boolean
}

/** 声明条目行形状判定（R75-2 节界前瞻用，与下方条目正则同步） */
function isLeadUpdateEntryLine(line: string): boolean {
  return /^-\s*\S+\s+[^\s:：]+[:：]\s*.+$/.test(line.trim())
}

/** 解析账本推进文本（`- <编号> <动词>：<证据>` 行；非列表行忽略）。
 *  R73-23（二十一轮）：对齐 format/leads.ts parseHistory 的续行折入口径——编辑器折行/
 *  手写换行的证据第二行此前被静默丢弃，声明证据与落盘履历（折入后续行）比对失配 →
 *  「声明了没兑现」假红。无条目前的行（标题/首行章标签）不折。
 *  R75-2（二十三轮）：ATX 标题行不再折入上一条证据——手写 `## 备注` 等标题折入后，
 *  证据 needle 派生自标题碎片、命中正文必败 →「声明了没兑现」定稿假红。分组标题
 *  （后随条目）跳过；节终标题（后无条目）终断，其后人工备注不再触碰条目数据。与
 *  parseHistory 共用 headingEndsSection 判定，两侧口径不漂移。 */
export function parseLeadUpdateLines(text: string): ChapterLeadUpdate[] {
  const out: ChapterLeadUpdate[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    // R28-10（二十八轮）：rawLine 保留原始缩进——嵌套子列表行（真条目的子项）须凭
    // 缩进识别，trimmed 后与顶层格式错行无法区分（见下方 warn 收窄）
    const rawLine = lines[i]!
    const line = rawLine.trim()
    if (ATX_HEADING_RE.test(line)) {
      if (headingEndsSection(lines, i, isLeadUpdateEntryLine)) break
      continue
    }
    if (!line.startsWith('-')) {
      // R73-23：非列表行折入上一条证据（换行归一空格；条目前无折入对象，忽略）
      if (out.length > 0 && line !== '') {
        const prev = out[out.length - 1]!
        prev.证据 = `${prev.证据} ${line}`.trim()
      }
      continue
    }
    // - <编号> <动词>：<证据>
    const m = line.match(/^-\s*(\S+)\s+([^\s:：]+)[:：]\s*(.+)$/)
    if (m) {
      const evidence = m[3]!.trim()
      if (!evidence) continue
      out.push({ leadId: m[1]!.trim(), 动词: m[2]!.trim(), 证据: evidence })
    } else {
      // R28-10（二十八轮）：R26-32 的「格式不符」warn 收窄——只对形似账本条目的顶层
      // 列表行告警。`---` 分隔线（`-` 连字符串）与嵌套子列表行（原始行带缩进，真条目
      // 的子项）同样以 `-` 开头却不匹配条目正则，此前被一并误告警刷屏；两者恢复静默
      // 跳过（不折入证据，与既有列表行语义一致），顶层真条目格式错仍留痕。
      if (/^-+$/.test(line) || /^\s/.test(rawLine)) continue
      // R26-32（二十六轮）：列表行但条目格式不符（缺「编号 动词：证据」结构）此前
      // 静默丢弃——作者写了推进声明却因格式错误整条失效无迹可查（「声明了没兑现」
      // 假红的隐性来源）。warn 留痕不中断解析（对齐 yaml.ts 无冒号行同款手法）。
      log.warn('lead-updates', `账本推进行格式不符被丢弃（应为「- 编号 动词：证据」）：${line.slice(0, 40)}`)
    }
  }
  return out
}

/** R61-14（第六十一轮）：账本推进主文件是否属于被检章（V-P2-14 声明侧同向收口）——
 *  带章标签且 ≠ 被检章 → false：批量连写后复检旧章时，他章证据不作本章「已兑现」
 *  参照；无标签旧文件 → true（宽容沿用，同 readLeadUpdatesAt 兼容口径）。 */
export function leadUpdatesInScopeForChapter(bookRoot: string, forChapter: number): boolean {
  const tag = readLeadUpdateChapterTag(join(bookRoot, LEAD_UPDATES_FILE))
  return tag === null || tag === forChapter
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

// ── ff-P1-1 / hh 批 2-1：本章推进单一真相源 ──────────────
/** 账本推进主文件（常量归一唯一出处——此前 lead-finalize / lead-update-draft 各持一份） */
export const LEAD_UPDATES_FILE = '工作区/账本推进.md'
/** 批量连写归档目录（X-P2-6 章节暂存；同上归一） */
export const LEAD_UPDATES_ARCHIVE_DIR = '工作区/.账本推进暂存'

/** 本章推进的读取源：主文件路径 + 本章归档路径 + 主文件是否属于本章。 */
export function chapterUpdateSources(
  bookRoot: string,
  chapterNo: number,
): { mainPath: string; archivePath: string; mainIsThisChapter: boolean } {
  const mainPath = join(bookRoot, LEAD_UPDATES_FILE)
  // 主文件章节标签=本章 或 无标签旧格式 → 属于本章；批量连写下主文件常载有
  // 其他章的待确认内容（X-P2-6），此时本章推进在归档。
  const mainTag = readLeadUpdateChapterTag(mainPath)
  return {
    mainPath,
    archivePath: join(bookRoot, LEAD_UPDATES_ARCHIVE_DIR, `第${chapterNo}章.md`),
    mainIsThisChapter: mainTag === null || mainTag === chapterNo,
  }
}

/**
 * 读「本章」全部已声明账本推进 = 主文件（属于本章时）+ 本章归档。
 * ff-P1-1：定稿防吃书闸与履历回写**必须**共用本函数——此前闸只读主文件、回写读
 * 主+归档，两源不对称：归档章的推进（批量连写常态）绕过闸直接落履历，「做了没
 * 声明」红失明、「声明已兑现」误阻断，闸对回写将写什么一无所知。
 * R31-3（三十一轮）：读失败（任一在位数据源不可读）维持按 [] 兜底——本函数的既有
 * 调用方（finalize 闸/履历回写，document 域）对「读失败=无推进」不敏感或自带
 * fail-open；两端闭合判定等降级敏感消费请走 readChapterUpdatesForChapterChecked。
 */
export function readChapterUpdatesForChapter(bookRoot: string, chapterNo: number): ChapterLeadUpdate[] {
  return readChapterUpdatesForChapterChecked(bookRoot, chapterNo).updates
}

/**
 * R31-3（三十一轮）：readChapterUpdatesForChapter 的读失败感知版——主文件（属于本章时）
 * 与本章归档两源任一「存在但读失败」→ unreadable:true（updates 为剩余可用部分）。
 * 调用方（checkWithDb 两端闭合）凭 unreadable 跳过闭合比对并产黄降级，不再把
 * 「清单未知」当「已声明未兑现」误报红硬阻断定稿。文件不存在仍属「无推进」已知态。
 */
export function readChapterUpdatesForChapterChecked(bookRoot: string, chapterNo: number): ChapterUpdatesResult {
  const { mainPath, archivePath, mainIsThisChapter } = chapterUpdateSources(bookRoot, chapterNo)
  let unreadable = false
  const parts: ChapterLeadUpdate[][] = []
  if (mainIsThisChapter) {
    const main = readLeadUpdatesAtChecked(mainPath)
    if (main === null) unreadable = true
    else parts.push(main)
  }
  const archive = readLeadUpdatesAtChecked(archivePath)
  if (archive === null) unreadable = true
  else parts.push(archive)
  return { updates: parts.flat(), unreadable }
}

/** 账本证据核心必须非空且在正文命中，避免 includes('') 把空证据误判为兑现。
 *  R63-8（十一轮）：匹配走 evidenceNeedles 多候选任一命中（单针串的内部闭引号会
 *  整组 miss——混合短引证据「雪落」无声 vs 正文无引号写法，见 leads.ts 头注）。 */
export function leadEvidenceMatchesBody(body: string, evidence: string): boolean {
  return evidenceNeedles(evidence).some((needle) => body.includes(needle))
}