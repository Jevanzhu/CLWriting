/**
 * 近况组装 —— 阶段 1（母本第 6.3 节）。
 *
 * 给 AI 起草细纲提供「当前书写到哪里了」的快照：
 * - 已定稿到第几章
 * - 账本状态（进行中的线 + 悬太久预警）
 * - 近章钩子/情绪（节奏连续性参考）
 * - 当前卷信息
 *
 * 全程读 M1 精准读取（format/read.ts），零 token 脚本组装。
 */

import type { DatabaseSync } from 'node:sqlite'
import {
  readStaleLeads,
} from '../format/read.js'
import type { BookConfig, LeadType } from '../format/types.js'

/** 账本阈值默认表（母本第 2.2 节，#9 可覆盖） */
const DEFAULT_THRESHOLDS: Record<LeadType, number> = {
  悬念: 10,
  感情线: 30,
  布局线: 15,
  设定线: 50,
  成长线: 40,
  关系线: 20,
}

// R0912-6（2026-09-11 修复批）：近况段进行中线索上限——openLeads 原取全部「进行中」
// 无 cap，而近况段是 essential（prepare 刚需不砍）：超长篇数百线时近况段无限膨胀。
// 源头封住：快照只保留最近 OPEN_LEADS_CAP 条（按 opened_at 升序现有排序取尾部=最近
// 开启的线），超限数随快照透出（openLeadsOmitted），formatStatus 追加一行提示；
// 悬太久的线另有 staleLeads 段承载，不因 cap 丢失预警面。
const OPEN_LEADS_CAP = 50

/** 近况快照（供阶段 1 起草细纲 + 阶段 3 备料） */
export interface StatusSnapshot {
  /** 已定稿的最新章号（0 = 还没开始写） */
  currentChapter: number
  /** 当前卷号 */
  currentVolume: number
  /** 进行中的账本（id/type/title/开启章/年龄）
   *  R0912-6：超过 OPEN_LEADS_CAP 条时只保留最近开启的 OPEN_LEADS_CAP 条（省略数见
   *  openLeadsOmitted）——近况段 essential 无裁剪通道，膨胀须在快照源头封住 */
  openLeads: {
    id: string
    type: LeadType
    title: string
    openedAt: number
  }[]
  /** R0912-6：因 cap 未列入 openLeads 的进行中线数（未超限缺省；formatStatus 据此追加提示行） */
  openLeadsOmitted?: number
  /** 悬太久预警（超阈值的进行中线） */
  staleLeads: {
    id: string
    type: LeadType
    age: number
    threshold: number
  }[]
  /** 近章钩子/情绪（最近 3 章） */
  recentChapters: {
    number: number
    title: string
    hookType: string | null
    emotion: string | null
  }[]
}

/**
 * 组装近况快照。
 * @param db 书仓库的缓存
 * @param config book.yaml 配置（读 thresholds + leads.enabled；GG-P2-6 起第三参缺省时还读 book.volume_size）
 * @param volumeSize 每卷章数（用于推算当前卷号）。显式传参优先；缺省回落
 *   config.book.volume_size（调用方喂 applyGlobalDefaults 之后的生效配置时，此处即
 *   书级 → global.json → 硬编码三层链的收口点），仍无才用 50
 * @param finalized 已定稿章号集合（低级项·第六轮：currentChapter 口径收口——chapters
 *   缓存表含 写作/正文 全部 .md（写稿即入缓存的草稿也在内），此前 MAX(number) 把
 *   写作中的草稿章也计进「已定稿最新章号」，与字段注释口径不符。传入即只数定稿章；
 *   PL-2（第七轮）：空集 = 清单在册零定稿（新书）→ currentChapter=0，不再回落含
 *   草稿全量；缺省（undefined，无清单旧书/旧测试夹具）保持全量口径。生产调用方
 *   （prepare / state / chapter_status）经 finalizedChapterSetOfBook 传值）
 */
export function assembleStatus(
  db: DatabaseSync,
  config: BookConfig,
  volumeSize?: number,
  finalized?: ReadonlySet<number>,
): StatusSnapshot {
  // GG-P2-6：第三参缺省原先硬编码 50——chapter_status 工具按「只传 config」调用导致
  // 卷号永远按 50 算（书级/global 配了别的值也读不到，断链）。改为缺省从生效配置收口。
  const size = volumeSize ?? config.book.volume_size ?? 50

  // 已定稿最新章号
  let maxNum: number | null
  if (finalized === undefined) {
    maxNum = (db.prepare('SELECT MAX(number) AS maxNum FROM chapters').get() as { maxNum: number | null }).maxNum
  } else {
    // R65-34（第六十五轮）：原先 IN 子句按定稿集展开占位符——极端章数（>999）触发
    // SQLite 编译版变量上限直接抛错；改全量读 number 后 JS 侧按定稿集过滤。语义与
    // 原实现逐一恒等：只数 chapters 表内且章号在定稿集的行（空集 → null，与 PL-2
    // 「清单在册零定稿 = currentChapter 0」口径一致；定稿集内不在表中的章号同不计）。
    const rows = db.prepare('SELECT number FROM chapters').all() as { number: number }[]
    maxNum = null
    for (const r of rows) {
      if (finalized.has(r.number) && (maxNum === null || r.number > maxNum)) maxNum = r.number
    }
  }
  const currentChapter = maxNum ?? 0

  // 当前卷号
  const currentVolume = currentChapter > 0 ? Math.ceil(currentChapter / size) : 1

  // 账本阈值（#9 覆盖默认）
  const thresholds: Record<string, number> = { ...DEFAULT_THRESHOLDS }
  if (config.leads.thresholds) {
    for (const [k, v] of Object.entries(config.leads.thresholds)) {
      thresholds[k] = v
    }
  }

  // 进行中的账本
  // R0912-6：行按 opened_at 升序（现有排序）——超 cap 取尾部（最近开启的线），省略数
  // 随快照透出；保序切片（升序不变，formatStatus 展示序与旧口径一致）
  const openRows = db.prepare(
    `SELECT id, type, title, opened_at FROM leads WHERE status = '进行中' ORDER BY opened_at`,
  ).all() as Record<string, unknown>[]
  const openLeadsAll = openRows.map((r) => ({
    id: r['id'] as string,
    type: r['type'] as LeadType,
    title: r['title'] as string,
    openedAt: r['opened_at'] as number,
  }))
  const openLeadsOmitted = Math.max(0, openLeadsAll.length - OPEN_LEADS_CAP)
  const openLeads = openLeadsOmitted > 0 ? openLeadsAll.slice(-OPEN_LEADS_CAP) : openLeadsAll

  // 悬太久（复用 readStaleLeads）
  const staleRaw = readStaleLeads(db, currentChapter, thresholds, 30)
  const staleLeads = staleRaw
    .filter((s) => s.overThreshold)
    .map((s) => ({
      id: s.id,
      type: s.type,
      age: s.age,
      threshold: thresholds[s.type] ?? 30,
    }))

  // 近 3 章钩子/情绪。P5-管线（第七轮）：按定稿线过滤（number <= currentChapter）——
  // chapters 表含在写草稿的钩子行，原先直接取最大 3 章会把未定稿草稿的钩子当
  // 「已定稿近章节奏」复述给模型（与 currentChapter 口径分裂）
  const recentRows = db.prepare(
    `SELECT number, title, hook_type, emotion FROM chapters
     WHERE number <= ? ORDER BY number DESC LIMIT 3`,
  ).all(currentChapter) as Record<string, unknown>[]
  const recentChapters = recentRows
    .map((r) => ({
      number: r['number'] as number,
      title: r['title'] as string,
      hookType: (r['hook_type'] as string | null) ?? null,
      emotion: (r['emotion'] as string | null) ?? null,
    }))
    .reverse() // 按章号升序

  return {
    currentChapter,
    currentVolume,
    openLeads,
    // R0912-6：仅超限时携带（未超限缺省，消费方零感知）
    ...(openLeadsOmitted > 0 ? { openLeadsOmitted } : {}),
    staleLeads,
    recentChapters,
  }
}

/** 近况快照 → 人话文本（供注入 AI 上下文） */
export function formatStatus(snapshot: StatusSnapshot): string {
  const lines: string[] = []
  lines.push(`【近况】已写到第 ${snapshot.currentChapter} 章（第 ${snapshot.currentVolume} 卷）`)
  lines.push('')

  if (snapshot.recentChapters.length > 0) {
    lines.push('【近章节奏】')
    for (const ch of snapshot.recentChapters) {
      const parts = [ch.title]
      if (ch.hookType) parts.push(ch.hookType)
      if (ch.emotion) parts.push(ch.emotion)
      lines.push(`  第${ch.number}章 ${parts.join(' · ')}`)
    }
    lines.push('')
  }

  if (snapshot.openLeads.length > 0) {
    lines.push(`【进行中的线】${snapshot.openLeads.length} 条`)
    for (const l of snapshot.openLeads) {
      lines.push(`  ${l.id} ${l.title}（第${l.openedAt}章开启）`)
    }
    // R0912-6：cap 生效时追加提示行——AI/作者可知晓尚有未列入的进行中线
    if (snapshot.openLeadsOmitted !== undefined && snapshot.openLeadsOmitted > 0) {
      lines.push(`（另有 ${snapshot.openLeadsOmitted} 条进行中线索未列入）`)
    }
    lines.push('')
  }

  if (snapshot.staleLeads.length > 0) {
    lines.push(`【⚠ 悬太久】${snapshot.staleLeads.length} 条超阈值`)
    for (const s of snapshot.staleLeads) {
      lines.push(`  ${s.id}（${s.type}）已悬 ${s.age} 章，阈值 ${s.threshold}`)
    }
  }

  return lines.join('\n')
}
