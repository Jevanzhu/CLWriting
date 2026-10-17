/**
 * 导出前三阶段：收集（readChapterDir 元数据扫描）→ 定稿过滤（manifest 单源）→ 排序编号。
 *
 * 不变量：收集只取元数据（正文在写出段逐章现读，峰值降为单章级）；过滤判据收敛到
 * finalizedPathSet；编号先排后编不可倒置（已发布章号固定，未发布段续编）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readChapterDir, isPublishedValue } from '../format/chapters.js'
import { readFile } from '../format/frontmatter.js'
import { finalizedPathSet } from '../document/manifest.js'
import { docJoinKey } from '../fs/safe-path.js'
import { isUtf8 } from '../shared/text.js'
import { errMsg } from '../log/index.js'
import { relPosixIn } from './naming.js'
import type { ExportUnit, ExportResult, StageResult } from './types.js'
/** 阶段一·收集：扫描定稿正文（统一 readChapterDir，递归卷结构）。
 * 不再 includeBody 一次读带出全部正文——极端大书（200 万字级）
 *  全部章正文 + 净化副本同时驻留内存可 OOM；改 meta-only 扫描，正文在写出段逐章现读
 * 即弃（读-写流水化，峰值降为单章级）。单个坏章（解析失败）不再拖垮整本导出
 *  ——记入 warnings 跳过，仍有可导章则继续。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段一）。 */
export function collectExportUnits(bookRoot: string, warnings: string[]): StageResult<{ units: ExportUnit[] }> {
  const bodyDir = join(bookRoot, '写作', '正文')
  if (!existsSync(bodyDir)) {
    return { ok: false, error: '没有定稿正文可导出。' }
  }
  const { chapters, errors } = readChapterDir(bodyDir)
  for (const e of errors) warnings.push(`${relPosixIn(bookRoot, e.file)}: ${e.message}`)
  // （阶段 24）：units 组装带出 sortKey（序 ?? 章号）与 published（_raw.已发布）——
  // readChapter 已将 `已发布` 容错落 _raw（中文键不在 KNOWN_FM_KEYS），经 isPublishedValue
  // 单源判定（与树 probe regex 同式）
  const units: ExportUnit[] = chapters.flatMap((ch) =>
    ch._path
      ? {
          num: ch.章号,
          title: ch.标题,
          path: ch._path,
          sortKey: ch.序 ?? ch.章号,
          published: isPublishedValue(ch._raw?.['已发布']),
        }
      : [],
  )
  if (units.length === 0 && warnings.length > 0) {
    return { ok: false, error: `章解析失败：${warnings.join('; ')}` }
  }
  if (units.length === 0) {
    return { ok: false, error: '没有定稿正文可导出。' }
  }
  return { ok: true, value: { units } }
}

/** 阶段二·过滤：「导出定稿正文」名要符实——滤掉从未定稿的章（manifest 无
 *  finalizedRevision；态7 流水线刚写出的在写章/坏 fm 草稿不再混进全本/分章/投稿视图）。
 * 判定收敛到 manifest.finalizedPathSet 单一真相（learn 收割同款，防两处漂移）。
 * 导出供分段直测（生产唯一调用点在 exportBook 阶段二）。 */
export function filterFinalizedUnits(
  bookRoot: string,
  units: ExportUnit[],
): {
  filtered: ExportUnit[]
  skippedDrafts: number
  finalizedFilter: ExportResult['finalizedFilter']
  finalizedPaths: Set<string> | null
} {
  const finalizedPaths = finalizedPathSet(bookRoot)
  // 定稿集身份折叠（win 大小写不敏感 FS 外部 case-only 改名后
  // 精确匹配失配，定稿章被当草稿跳过）；非 win 并非恒等——platformCaseFold（收编、
  // 折叠面扩 darwin）在 darwin 也折叠，仅 linux 恒等（mac适配
  // 注释勘误：原注「posix 恒等」失实，零行为变化）
  const finalizedKeys = finalizedPaths === null ? null : new Set([...finalizedPaths].map(docJoinKey)) // 升 docJoinKey（+NFC 归一）
  // 清偿-导出未过滤提示：过滤是否生效的显式标记（见
  // ExportResult.finalizedFilter 注）——自此以下各构造点（含失败信封）一律携带
  const finalizedFilter: ExportResult['finalizedFilter'] = finalizedPaths === null ? 'skipped-no-manifest' : 'applied'
  let skippedDrafts = 0
  const filtered: ExportUnit[] =
    finalizedPaths !== null
      ? units.filter((u) => {
          // relative() 在 Windows 产反斜杠而 manifest path 是正斜杠——
          // 不归一会把全部章误判未定稿、导出为空（对齐 state.ts 既有 slash 归一口径）
          if (finalizedKeys?.has(docJoinKey(relative(bookRoot, u.path)))) return true
          skippedDrafts++
          return false
        })
      : units
  return { filtered, skippedDrafts, finalizedFilter, finalizedPaths }
}

/** 阶段三·编号：按排序键数值排序（`序 ?? 章号`——不依赖文件名字符串序；tie 章号
 * 保稳定），随后分流编号。
 *  顺序不变量：编号按排序后序位——先排后编不可倒置。
 * （阶段 24）分流：已发布章固定本地章号，其后未发布段从「已发布最大章号+1」
 *  按 sortKey 序位连续编。全无已发布章时（旧书常态）从 1 连续编——无 `序` 且章号
 *  连续的旧书 displayNum ≡ num，零漂移；章号空洞（合并留洞）在分章前缀上闭合。
 * （作者指令「按建议顺序开工」）：displayNum 语义拍板维持
 * 已发布章号不可变优先于显示序单调（发布号是读者侧锚点）；已发布章不居
 * sortKey 序前时显示序非单调（[6,7,8,9,5,10] 形态源码 ⑰）系该语义的
 *  自然结论，接受不改。
 * 导出供分段直测（纯函数：排序 +编号，生产唯一调用点在 exportBook 阶段三）。 */
export function orderAndNumberUnits(filtered: ExportUnit[]): void {
  filtered.sort((a, b) => a.sortKey - b.sortKey || a.num - b.num)
  const maxPublished = filtered.reduce((m, u) => (u.published ? Math.max(m, u.num) : m), 0)
  let next = maxPublished + 1
  for (const u of filtered) u.displayNum = u.published ? u.num : next++
}

/** 写出段内部：逐章现读正文（frontmatter.readFile 单源，剥 fm 取 body）。
 *  返回 null = 读取失败/正文为空（已记 warnings，调用方跳过该章）。
 * 导出供分段直测（生产唯一调用点在 writeExportProducts）。 */
export function readUnitBody(bookRoot: string, u: ExportUnit, warnings: string[]): string | null {
  // 导出链非 UTF-8 防线——save/finalize 链均有 isUtf8Bytes 闸
  //（document/service.ts:71 同款 TextDecoder fatal 口径），导出侧 utf-8 文本直读会让
  // GBK 章产出 U+FFFD 乱码且零警告、照常计入 chapterCount。按字节先验：非 UTF-8
  // 记警告按读取失败同口径跳过（源文件只读不动，作者转码后可再导出）。
  let bytes: Buffer
  try {
    bytes = readFileSync(u.path)
  } catch (e) {
    warnings.push(`${relPosixIn(bookRoot, u.path)}: 正文读取失败（${errMsg(e)}），已跳过`)
    return null
  }
  if (!isUtf8(bytes)) {
    warnings.push(
      `${relPosixIn(bookRoot, u.path)}: 正文不是 UTF-8 编码（如 GBK 旧档），导出会产生乱码，已跳过——请先转码为 UTF-8 再导出`,
    )
    return null
  }
  // 字节已验 UTF-8，toString 无损；复用同份内容走 readFile 解析（避免双读竞态）
  const r = readFile(u.path, bytes.toString('utf-8'))
  if (!r.ok) {
    warnings.push(`${relPosixIn(bookRoot, u.path)}: 正文读取失败（${r.error.message}），已跳过`)
    return null
  }
  // 判空按 trim 口径——全空白正文（纯空行/空白符，非空串）用 `!r.body` 判不住，
  // 会照常计入章数并在产物中产出空壳章节（分隔符 + 空段）。
  // 净化管线（stripAuthorNotes 后 trim）本就会把它打成空串，此处提前同口径拦截。
  if (r.body.trim() === '') {
    warnings.push(`${relPosixIn(bookRoot, u.path)}: 正文为空，已跳过`)
    return null
  }
  return r.body
}
