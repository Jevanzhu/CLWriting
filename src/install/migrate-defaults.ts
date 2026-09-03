/**
 * 一次性迁移：清掉旧 scaffold 烘焙进 book.yaml 的 13 键默认值（书级设定全局托底配套）。
 *
 * 为什么必须迁：旧建书把 style.injection: light / auto.confirm_outline: false /
 * budget.calls_per_chapter: 8 / genre: '' 等默认值直接写进了书文件——解析结果恒有值，
 * 「书级未设 → 回落 global.json 全局默认」的托底永远被遮蔽。只有把这些「恰好等于旧默认」
 * 的键删掉，书级覆盖与全局默认的分层才成立。
 *
 * 判定口径：值 === 旧默认才删（作者改过的值一律保留）。删除清单：
 *   book.genre ''/缺失、style.injection 'light'、auto.confirm_outline false、
 *   auto.batch_size 8（短篇的 1 是有意产品默认，不动）、budget.calls_per_chapter 8、
 *   auto.relation_auto_mine false、auto.relation_mine_threshold 3、short.strict false、
 *   rag 段恰为 {enabled:false} 纯净态（无 provider/endpoint/model）才整段删。
 *   volume_size/target_words/chapter_target_words 从不被 scaffold 烘焙 → 跳过。
 *
 * 红线（保注释保未知段）：必须文本级补丁——readBookConfig 只保已知字段，
 * stringifyBookConfig 全量重生成会把作者的 # 注释、未知段、未知子键静默丢掉。
 * 这里照 patchTopSection（yaml.ts）的先例做「删段内 key 行 / 删整段」的文本操作。
 *
 * 健壮性：幂等（二跑无 diff——目标键已删，解析值不再等于旧默认，全部 no-op）、
 * 每本书独立 try/catch（单本失败 log.warn 不阻断）、汇总 log.info。
 *
 * 平台规范化批·评审补翻（2026-09-03）：整输出再经 canonicalizeText 归一（LF 无 BOM）——
 * 此前自有删行补丁器只做删行，未触碰行的 CRLF 残尾原样保留（与 yaml.ts 补丁族的分叉，
 * 方案 §四 曾记「语义不变」，评审 P3-1 收口改翻）；CRLF/BOM 存量 book.yaml 自此随启动
 * 迁移自愈（解析失败的原样返回分支不动——无法安全改写坏文件）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { canonicalizeText } from '../fs/text-canonical.js'
import { readBooks } from './books.js'
import { parseBookConfig } from '../format/yaml.js'
import { log } from '../log/index.js'

/** 迁移汇总（供测试断言 + 启动日志） */
export interface MigrateBookDefaultsResult {
  /** 检查的书数（books.jsonl 登记的全部书） */
  books: number
  /** 实际改写的书数（幂等重跑时为 0） */
  changed: number
  /** 单本失败数（已逐本 warn，不影响其他书） */
  failed: number
}

/** 枚举工作目录全部书，逐本清理旧默认值键。启动期调用（studio/server/index.ts）。 */
export function migrateBookDefaults(workDir: string): MigrateBookDefaultsResult {
  const books = readBooks(workDir)
  let changed = 0
  let failed = 0
  for (const book of books) {
    try {
      const yamlPath = join(workDir, book.path, 'book.yaml')
      if (!existsSync(yamlPath)) continue // 无 book.yaml 的书（登记残留）跳过不报错
      const before = readFileSync(yamlPath, 'utf8')
      const after = migrateBookYamlText(before)
      // 幂等闸：文本无变化不写盘（也避免无谓的 mtime 抖动触发外部同步）
      if (after !== before) {
        atomicWriteFile(yamlPath, after)
        changed++
        log.warn('migrate-defaults', `${book.name}: 已改写 book.yaml（键清理/行尾归一，全局托底生效）`)
      }
    } catch (e) {
      // 单本失败不阻断：迁移是「锦上添花」的清理，宁可留着旧默认也不能挡启动
      failed++
      log.warn('migrate-defaults', `${book.name} 迁移失败（跳过）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  log.info('migrate-defaults', `书级默认值清理完成：检查 ${books.length} 本，改写 ${changed} 本，失败 ${failed} 本`)
  return { books: books.length, changed, failed }
}

/**
 * 单本迁移（纯函数：文本进文本出，便于单测）。
 * 损坏 yaml 返回原文——无法判定「值 === 旧默认」时宁可不改，不可改错。
 */
function migrateBookYamlText(raw: string): string {
  const parsed = parseBookConfig(raw)
  if (!parsed.ok) return raw
  const cfg = parsed.config
  let out = raw

  // 逐键：解析值 === 旧默认才删。genre 在解析层已把空串归一 undefined，
  // 缺失/空串两种形态统一走「删行」（行不存在时删除操作本身 no-op）
  if (cfg.book.genre === undefined) out = deleteSectionKey(out, 'book', 'genre')
  if (cfg.style?.injection === 'light') out = deleteSectionKey(out, 'style', 'injection')
  if (cfg.auto?.confirm_outline === false) out = deleteSectionKey(out, 'auto', 'confirm_outline')
  // 短篇的 batch_size: 1 是有意产品默认（逐篇确认再续写），不在删除条件里
  if (cfg.auto?.batch_size === 8) out = deleteSectionKey(out, 'auto', 'batch_size')
  if (cfg.budget.calls_per_chapter === 8) out = deleteSectionKey(out, 'budget', 'calls_per_chapter')
  if (cfg.auto?.relation_auto_mine === false) out = deleteSectionKey(out, 'auto', 'relation_auto_mine')
  if (cfg.auto?.relation_mine_threshold === 3) out = deleteSectionKey(out, 'auto', 'relation_mine_threshold')
  if (cfg.short?.strict === false) out = deleteSectionKey(out, 'short', 'strict')

  // rag 段：仅当恰为 {enabled: false} 纯净态才整段删——带 provider/endpoint/model 的
  // 是作者真实配置（或旧内联存量），整段删会让 resolve 链落空；candidate_depth（A3 批 7）
  // 同属作者配置，带上它整段删会静默丢已配候选深度（启用后回落缺省 20）
  if (
    cfg.rag?.enabled === false &&
    cfg.rag.provider === undefined &&
    cfg.rag.endpoint === undefined &&
    cfg.rag.model === undefined &&
    cfg.rag.candidate_depth === undefined
  ) {
    out = deleteTopSection(out, 'rag')
  }
  // 平台规范化批·评审补翻：整输出归一规范形（LF 无 BOM）——与 yaml.ts 补丁族同款闭环
  return canonicalizeText(out)
}

// ── 文本操作（照 yaml.ts patchTopSection 的段区间口径）────────

/** 顶层段区间 [start, end)：end = 下一个顶层 key 行（非缩进、非注释、非空行）之前 */
/** Z-7（第五十八轮）：段定位 CRLF 容忍（同 yaml.ts matchesKeyLine 口径——本地
 *  复制避免跨模块引私有；口径漂移由两处测试共同锁定） */
function matchesKeyLineCRLF(line: string, key: string): boolean {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line
  return bare === `${key}:` || bare.startsWith(`${key}: `)
}

function topSectionSpan(lines: string[], section: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => matchesKeyLineCRLF(l, section))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (l.trim() !== '' && !l.trimStart().startsWith('#') && !/^\s/.test(l)) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 行是否为段内直接子键 `key:`（恰好 childIndent 缩进 + key + 冒号；行尾可带值/注释） */
/** R37-23（三十七轮）：剥行尾 \r 再判（同 matchesKeyLineCRLF 的 Z-7 口径）——CRLF 文件
 *  split('\n') 残留 \r 尾，裸子键行（`  genre:\r`）的 === 比对失配、判定落空 → 删除
 *  no-op 原样返回，迁移静默丢改（幂等重跑也无 diff，作者无感知）。带值形态
 *  （`  genre: ''\r`）startsWith 分支不受行尾影响，本就命中。 */
function isChildKeyLine(line: string, key: string, childIndent: number): boolean {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line
  const head = ' '.repeat(childIndent) + `${key}:`
  return bare === head || bare.startsWith(`${head} `)
}

/**
 * 删除 section 内直接子键 key 的行（全部出现处）。
 * 删后段内已无内容行 → 连段头一起删（整段消失）。
 * 「内容行」判定：非空且非 0 缩进注释——0 缩进注释属于段间缝隙（作者写在段外的说明），
 * 不算段内容、也不随段陪葬；段内缩进注释算内容（保头保注释）。
 */
function deleteSectionKey(raw: string, section: string, key: string): string {
  const lines = raw.split('\n')
  const span = topSectionSpan(lines, section)
  if (!span) return raw
  const body = lines.slice(span.start + 1, span.end)
  // 直接子键缩进 = 段体内最小缩进（嵌套更深的行不是本段的直接子键，绝不能碰）
  let childIndent = -1
  for (const l of body) {
    if (l.trim() === '' || l.trimStart().startsWith('#')) continue
    const ind = l.length - l.trimStart().length
    if (childIndent === -1 || ind < childIndent) childIndent = ind
  }
  if (childIndent === -1) return raw // 段体空（无内容行）——没有可删的 key
  const kept = body.filter((l) => !isChildKeyLine(l, key, childIndent))
  if (kept.length === body.length) return raw // 没命中（key 行不在）——原样返回（幂等源）

  // 段内还有内容行（含缩进注释）→ 保留段头，仅抽掉目标行
  const isContent = (l: string): boolean =>
    l.trim() !== '' && !(!/^\s/.test(l) && l.trimStart().startsWith('#'))
  if (kept.some(isContent)) {
    lines.splice(span.start + 1, body.length, ...kept)
    return lines.join('\n')
  }
  // 段已空（可能只剩 0 缩进注释/空行）→ 整段删；0 缩进注释由 deleteTopSection 保下
  return deleteTopSection(lines.join('\n'), section)
}

/** 删除整个顶层段（段头 + 段体 + 段间空行；0 缩进注释及其紧邻空行不陪葬） */
function deleteTopSection(raw: string, section: string): string {
  const lines = raw.split('\n')
  const span = topSectionSpan(lines, section)
  if (!span) return raw
  const wasLast = span.end >= lines.length
  // 段区间内保留：0 缩进注释（patchTopSection 语义里段区间归段所有，但删除语义下
  // 作者写在段缝隙的注释不该跟着段陪葬——保守保留，宁可少删），以及紧邻这些注释的
  // 空行（保住注释原有的呼吸感，不让它粘到下一段头上）
  const n = span.end - span.start - 1
  const keep = new Array<boolean>(n).fill(false)
  const isGapComment = (l: string): boolean => !/^\s/.test(l) && l.trimStart().startsWith('#')
  for (let j = 0; j < n; j++) {
    const l = lines[span.start + 1 + j]!
    if (isGapComment(l)) keep[j] = true
  }
  for (let j = 0; j < n; j++) {
    const l = lines[span.start + 1 + j]!
    if (l.trim() === '' && ((j > 0 && keep[j - 1]) || (j < n - 1 && keep[j + 1]))) keep[j] = true
  }
  const keptFromSpan = lines.slice(span.start + 1, span.end).filter((_, j) => keep[j])
  lines.splice(span.start, span.end - span.start, ...keptFromSpan)
  // 防双空行：删除点前后都是空行时去掉一个（原本由段隔开，现在粘连成两行）
  const at = span.start
  if (at > 0 && at < lines.length && lines[at - 1]!.trim() === '' && lines[at]!.trim() === '') {
    lines.splice(at, 1)
  }
  let out = lines.join('\n')
  // 段在文件尾：收掉尾部空行堆积（保持文件以单个换行收尾，与 stringify 产物风格一致）
  if (wasLast) out = out.replace(/\n+$/, '\n')
  return out
}
