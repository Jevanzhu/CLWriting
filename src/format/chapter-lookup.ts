/**
 * 章号回退 helper 单源（阶段 24 章节结构操作，留洞制）。
 *
 * 被合并的源章从正文区消失（软删回收站），其去向记录在目标章 fm `并入`——按名定位族
 * （数字前缀查表）对源章号 miss 时，经本模块回退到目标章正文：历史章号引用（履历行/
 * 伏笔埋设章/前章正文结尾等）在合并后仍可命中。正文命中恒优先（文件一回来按名即中，
 * 陈旧 `并入` 映射永不被咨询——通用还原的惰性无害语义）。
 *
 * 成本口径（风险登记 3）：mergedIntoMap 走 readChapterDir meta-only 扫描，其
 * (mtimeNs,size) 逐文件 stat 指纹缓存吸收解析成本；本模块不另建 Map 级
 * 目录指纹缓存（实施首步核实既有缓存形态——已有，无需加）。调用方按需构建（仅 miss
 * 时咨询），勿在热路径每请求主动重建。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readChapterDir, chapterNamePrefixes, parseMergedInto, parseOrderOf } from './chapters.js'
import { splitFrontMatter, parseFlat, patchFlatFm } from './frontmatter.js'
import { walkMdFind } from '../fs/walk-md.js'
import { readMdTextCached } from '../fs/md-text-cache.js'
import { log } from '../log/index.js'

/**
 * `并入` 登记单源（冲突 warn + 覆盖）——mergedIntoMap 与「同一次读取顺带解析」的
 * 消费方（foreshadow walk，零额外 IO 约束见其指纹缓存契约）共用同一条登记口径。
 */
export function registerMergedInto(map: Map<number, string>, src: number, targetPath: string): void {
  if (map.has(src)) {
    log.warn('chapter-lookup', `并入映射冲突：源章 ${src} 同时被 ${map.get(src)} 与 ${targetPath} 吸收（后扫覆盖——请核对 并入 登记）`)
  }
  map.set(src, targetPath)
}

/**
 * 构建 `并入` 映射：源章号 → 目标章绝对路径（readChapterDir 一遍 meta-only 扫描）。
 * 写侧链式折叠单跳化（11 并 12,13 时 11.并入 = [12, 13]，源 13 直接重指向 11），读侧
 * 无递归；盘面出现「目标自身也被并入」的中间态时按单跳值返回（崩溃不变量由 repair
 * 收口，读取侧不做递归解析）。
 * 跨卷重号先例对齐（foreshadow.ts）：两个章都声明吸收同一源章号时 warn 不炸、后扫
 * 覆盖（与 collectChapterTexts 的「足迹按后扫文件计」同口径）。
 * 成本：首调付一遍 meta 全扫（readChapterDir 的 (mtimeNs,size) stat 缓存吸收后续）——
 * 仅在按名 miss 后惰性调用；热路径（伏笔足迹等已整读正文的扫描）应走「同读顺带解析」
 * （parseMergedInto + registerMergedInto），勿每请求重建本 Map。
 */
export function mergedIntoMap(bookRoot: string): Map<number, string> {
  const map = new Map<number, string>()
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) return map
  const { chapters } = readChapterDir(bodyDir)
  for (const ch of chapters) {
    if (!ch.并入 || !ch._path) continue
    for (const src of ch.并入) registerMergedInto(map, src, ch._path)
  }
  return map
}

/**
 * 按章号定位正文文件（含 并入 回退）：按名定位（chapterNamePrefixes 三口径：无补零/
 * 3 位/4 位）命中优先、短路不咨询 Map；miss 查 mergedIntoMap 取目标章路径；再 miss
 * 返 null（调用方既有容错）。
 */
export function chapterPathByNumber(bookRoot: string, chapter: number): string | null {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (existsSync(bodyDir)) {
    const prefixes = chapterNamePrefixes(chapter)
    const hit = walkMdFind(bodyDir, (abs, name) =>
      prefixes.some((p) => name.startsWith(p)) ? abs : undefined,
    )
    if (hit !== undefined) return hit
  }
  return mergedIntoMap(bookRoot).get(chapter) ?? null
}

/**
 * 按章号取正文（剥 front matter；含 并入 回退）——章号回退读取单源。
 * 读失败/无 fm/未闭合 fm 按调用方容错口径：无 fm 的裸 md 原样返回（readMdTextCached
 * 降级语义族）。返回 null = 章号既不在正文也无并入去向。
 */
export function chapterTextByNumber(bookRoot: string, chapter: number): string | null {
  const path = chapterPathByNumber(bookRoot, chapter)
  if (path === null) return null
  const raw = readMdTextCached(path)
  if (raw === null) return null
  const split = splitFrontMatter(raw)
  return split ? split.body : raw
}

// ── 阶段 24 结构键保形（组装/强覆盖链的 序/并入 透传）──────────────────

/** 把盘上既有章 fm 的 序/并入 透传进即将强覆盖的内容（saveDraft 锁内回补单源）。
 *  键级保形：incoming fm 已显式含该键则不覆写（显式产出优先）；盘上无键 / 文件不
 *  存在 / incoming 无 fm（裸 md）→ 原样返回。读失败原样返回（保形是防丢键兜底，
 *  不因它拒绝写盘——写侧防线在保存链自身）。
 *  （四轮处置批）：existingRaw = 调用方在保存锁内预读的盘上字节（文件
 *  不存在传 null），提供时不再读盘——saveDraft 三路（保形/留底/revision）单读共用；
 *  缺省 undefined = 自读（preserveStructureFmForChapter 等其余调用方原样）。 */
export function preserveStructureFmIn(absPath: string, content: string, existingRaw?: Buffer | null): string {
  if (existingRaw === null) return content // 调用方锁内预读断言「文件不存在」→ 无键可保形
  if (existingRaw === undefined && !existsSync(absPath)) return content
  const split = splitFrontMatter(content)
  if (split === null) return content
  let raw: string
  if (existingRaw !== undefined) {
    raw = existingRaw.toString('utf-8')
  } else {
    try {
      raw = readFileSync(absPath, 'utf-8')
    } catch {
      return content
    }
  }
  const disk = splitFrontMatter(raw)
  if (disk === null) return content
  const diskMap = parseFlat(disk.fmRaw)
  const inMap = parseFlat(split.fmRaw)
  const updates: Record<string, unknown> = {}
  const order = parseOrderOf(diskMap.get('序'))
  if (order !== undefined && !inMap.has('序')) updates['序'] = order
  const merged = parseMergedInto(diskMap.get('并入'))
  if (merged !== undefined && !inMap.has('并入')) updates['并入'] = merged
  if (Object.keys(updates).length === 0) return content
  const patched = patchFlatFm(split.fmRaw, updates)
  if (!patched.ok) return content
  return `---\n${patched.text}\n---\n${split.body}`
}

/** 按章号定位后透传（组装方用：self-heal assembleChapter 产出后、saveDraft 之前的
 *  显式注入——saveDraft 锁内另有 preserveStructureFmIn 兜底，两道共保 journal pending
 *  快照与最终落盘都带结构键）。 */
export function preserveStructureFmForChapter(bookRoot: string, chapter: number, content: string): string {
  const path = chapterPathByNumber(bookRoot, chapter)
  if (path === null) return content
  return preserveStructureFmIn(path, content)
}
