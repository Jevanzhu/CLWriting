/**
 * 导出入口 exportBook：参数校验 → 六阶段编排（收集 / 过滤 / 编号 / 备目录 / 写出 / 投稿视图）。
 *
 * 不变量：全部失败路径走 {ok:false} 信封（过滤阶段前 failEarly、其后 fail 两族分工见下）；
 * 零成功章不落空壳产物。
 */
import { join } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { collectExportUnits, filterFinalizedUnits, orderAndNumberUnits } from './collect.js'
import { prepareExportLayout, writeExportProducts } from './layout.js'
import { writeSubmissionView } from './submission.js'
import type { ExportOptions, ExportResult, ExportRun, ExportPlan } from './types.js'
/** 入口参数校验单源（format/output 同为 API/worker 透传面：TS 类型拦不住运行期
 *  JSON）——非法值返回参数错误文案，合法返回 null。format 非法值会让
 *  doMerged/doSplit 双 false：全部章静默跳过写入，落到「零产出」收口误报
 *  「正文全部为空或读取失败」，病因完全错位（误导作者去查正文）；output 非法值
 *  静默按 md 处理则让作者以为拿到纯文本稿。两者一律显式参数错误返回，不做任何盘上操作。 */
function validateExportParams(format: unknown, output: unknown): string | null {
  if (format !== 'merged' && format !== 'split' && format !== 'both') {
    return `参数错误：format=${JSON.stringify(format)} 非法（只接受 merged / split / both）`
  }
  if (output !== 'md' && output !== 'txt') {
    return `参数错误：output=${JSON.stringify(output)} 非法（只接受 md / txt）`
  }
  return null
}

export function exportBook(options: ExportOptions): ExportResult {
  const { bookRoot, platform = 'generic' } = options
  const format = options.format ?? 'both'
  const output = options.output ?? 'md'
  // 前置失败（未达定稿过滤阶段）信封单源——finalizedFilter
  // 恒 'applied'（值不参与语义，见 ExportResult.finalizedFilter 注）、无 skippedDrafts/
  // warnings 面。与下方 fail（过滤阶段后）分立：二者捕获的变量面不同，前置闭包不引用
  // 尚未声明的 warnings/finalizedFilter/skippedDrafts（TDZ）。
  const failEarly = (error: string): ExportResult => ({
    ok: false,
    files: [],
    chapterCount: 0,
    unit: '章',
    finalizedFilter: 'applied',
    error,
  })
  // format/output 入口校验（见 validateExportParams）——前置失败未达过滤阶段
  //（零产物，finalizedFilter 值不参与语义），两处失败共用同一前置信封
  const invalidParam = validateExportParams(format, output)
  if (invalidParam !== null) {
    return failEarly(invalidParam)
  }
  const cfg = readBookConfig(join(bookRoot, 'book.yaml'))
  const kind = cfg.ok && cfg.config.kind === 'short' ? 'short' : 'long'
  // 正文为空/读取失败的单章在写出段现读时判定（起正文不预读），
  // 记警告跳过，不再整本失败；零可写章按 writtenCount 收口
  const warnings: string[] = []

  // ── 阶段一·收集（拆段）──
  const collected = collectExportUnits(bookRoot, warnings)
  if (!collected.ok) return failEarly(collected.error)
  const units = collected.value.units

  // ── 阶段二·过滤 ──
  const { filtered, skippedDrafts, finalizedFilter, finalizedPaths } = filterFinalizedUnits(bookRoot, units)
  // 失败信封单源——下方 7 处 {ok:false, files, chapterCount:0,
  // unit:'章', finalizedFilter, skippedDrafts, ...(warnings), error} 同构字面量收编单行调用。
  // warnings/finalizedFilter/skippedDrafts 闭包捕获（求值时机 = 调用时刻，与原字面量一致）；
  // filesSnapshot 仅两处「已落盘产物回填」（口径：split 项 ⟺ 已落盘、merged 名仅
  // 完整发布后列）传当时 files 快照，其余恒 []。前置失败（过滤阶段前）走上方 failEarly。
  const fail = (error: string, filesSnapshot?: string[]): ExportResult => ({
    ok: false,
    files: filesSnapshot ?? [],
    chapterCount: 0,
    unit: '章',
    finalizedFilter,
    skippedDrafts,
    ...(warnings.length > 0 ? { warnings } : {}),
    error,
  })
  const run: ExportRun = { bookRoot, warnings, files: [], writtenCount: 0, writtenNums: new Set() }
  if (filtered.length === 0) {
    return fail(`正文区共 ${units.length} 章均未定稿，没有可导出的定稿正文；请先在文档树中定稿。`)
  }

  // ── 阶段三·编号 ──
  orderAndNumberUnits(filtered)

  const doMerged = format === 'merged' || format === 'both'
  const doSplit = format === 'split' || format === 'both'
  // 读书名（用于合并文件名；book.yaml #9 格式）
  const bookTitle = cfg.ok && cfg.config.book.title ? cfg.config.book.title : '未命名'

  // ── 阶段四·备目录（母本 6.2 工作区/导出/）──
  const layout = prepareExportLayout({ bookRoot, bookTitle, doMerged, doSplit, warnings, output })
  if (!layout.ok) return fail(layout.error)
  const plan: ExportPlan = { ...layout.value, filtered }

  // ── 阶段五·写出（全本流式 / 分章逐章）──
  const wrote = writeExportProducts(run, plan)
  if (!wrote.ok) return fail(wrote.error, wrote.files)

  // 定稿章在册但全部空正文/读取失败 → 零产物，按失败收口（与定稿预滤后走同一信封；
  // 具体病因见 warnings 逐章留痕）。
  // 文案如实归因——到达此处时各章**均已定稿**（filtered 即定稿集），真实病因是空正文/
  // 读取失败；说「均未定稿，请先在文档树中定稿」会误导作者去重复定稿操作。
  // 配合 publish 裁定，盘上亦无空壳产物残留。
  // 报数口径——units.length 是正文区全部章数，跳过草稿（skippedDrafts>0）或无清单兜底
  // （finalizedPaths===null）时按它报「有定稿章 N 章」会虚高（10 章仅 1 定稿且空 → 误报
  // 10 章）。分口径如实表述：有定稿清单报定稿章数（filtered.length，另注跳过的草稿数）；
  // 无清单兜底改说正文区全部章（未按定稿过滤）。
  if (run.writtenCount === 0) {
    const scope =
      finalizedPaths !== null
        ? `有定稿章 ${filtered.length} 章但正文全部为空或读取失败${skippedDrafts > 0 ? `（另有 ${skippedDrafts} 章未定稿已跳过）` : ''}`
        : `正文区 ${units.length} 章的正文全部为空或读取失败（未找到定稿清单，未按定稿过滤）`
    return fail(`${scope}，没有可导出的内容；逐章原因见 warnings。`)
  }

  // ── 阶段六·投稿视图（short 分支整体收编进错误信封——只包了
  // merged/split 写入，投稿视图的 scanShortCollection/readdirSync 清点/atomicWriteFile
  // 裸穿：磁盘满/目录并发删除时异常破坏 {ok:false} 契约、worker 形态丢 warnings 上下文）──
  // txt 面不出投稿视图：它是 Markdown 策划视图（含表格/字段），剥成纯文本只损失
  // 可读性（正文 txt 的用途是直接粘贴/上传，策划视图用途是作者自看）。
  if (kind === 'short' && output === 'md') {
    const view = writeSubmissionView({
      bookRoot,
      exportDir: plan.exportDir,
      cfg,
      bookTitle,
      platform,
      writtenNums: run.writtenNums,
      warnings,
      files: run.files,
    })
    if (!view.ok) return fail(view.error, view.files)
  }

  return {
    ok: true,
    files: run.files,
    chapterCount: run.writtenCount,
    unit: '章',
    // 清偿-导出未过滤提示：成功面核心消费点——清单缺失
    // （skipped-no-manifest）时前端据此明示「本次导出未按定稿过滤（含未定稿章）」
    finalizedFilter,
    skippedDrafts,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}
