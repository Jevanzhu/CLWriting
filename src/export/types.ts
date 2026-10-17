/**
 * 导出域公共类型（选项 / 结果信封 / 分段直测单元 / 运行态 / 备目录产物）。
 *
 * 零 IO、零业务依赖——实现件与外部消费方（studio/api/io.ts、worker 壳）共用；
 * 分段直测签名（ExportRun / ExportPlan / StageResult）也在本文件声明。
 */
import type { ShortSubmissionPlatform } from '../metrics/short-index.js'
export type ExportFormat = 'merged' | 'split' | 'both'
/** 平台标识（配置化：查 SUBMISSION_TEMPLATES，未知平台 fallback generic）。 */
export type ExportPlatform = ShortSubmissionPlatform
/** 输出形态：md = 现口径（`# 标题` + Markdown 正文，原样）；txt = 纯文本
 *  （剥呈现层标记，UTF-8 无 BOM + LF，落 导出/纯文本/）。markdown 正文附带的
 *  `#`/`**` 等标记对「直接粘贴/上传到平台」是噪声，故单列 txt 面。 */
export type ExportOutput = 'md' | 'txt'

export interface ExportOptions {
  /** 书仓库根 */
  bookRoot: string
  /** 导出形态（默认 both） */
  format?: ExportFormat
  /** 短篇投稿视图模板（长篇忽略；仅 md 输出面——见 output） */
  platform?: ExportPlatform
  /** 输出形态（默认 md）。txt 只出正文形态（merged/split），投稿视图为
   *  Markdown 策划视图（含表格/字段），不进 txt 面。 */
  output?: ExportOutput
}

export interface ExportResult {
  ok: boolean
  /** 导出的文件列表（相对书仓库的路径） */
  files: string[]
  /** 导出的章数 */
  chapterCount: number
  /** 导出对象单位 */
  unit: '章'
  /** 因未定稿被滤掉的章数（前端可提示） */
  skippedDrafts?: number
  /** 清偿-导出未过滤提示：定稿过滤是否实际生效。
   * 定稿清单缺失（finalizedPathSet → null）时导出兜底不过滤（宁多勿漏，
   * 哲学不动），成功结果须显式标记，否则作者可能拿含未定稿章的全本而不自知——
   * 服务端信封/前端 toast 透传展示。
   *  'applied' = 已按定稿清单过滤；'skipped-no-manifest' = 清单缺失未过滤（结果含未定稿章）。
   *  判定发生在正文扫描后（finalizedPathSet 读取处）：过滤阶段前的失败路径（参数错/无章
   *  可扫）未达过滤阶段且零产物，值不参与语义，统一置 'applied' 保必填契约。 */
  finalizedFilter: 'applied' | 'skipped-no-manifest'
  /** 单章级问题（解析失败/正文为空被跳过）——个别坏章不再拖垮整本导出 */
  warnings?: string[]
  /** 错误信息 */
  error?: string
}

/** 导出单元（收集段产出、过滤/编号/写出段消费）——导出供分段直测。 */
export interface ExportUnit {
  num: number
  title: string
  path: string
  /** （阶段 24）：排序键 = fm `序` ?? 章号（缺省语义；无 序 旧书 = 章号，零漂移）。 */
  sortKey: number
  /** （阶段 24）：已发布判据（readChapterDir `_raw.已发布` 解析，B.4——导出侧
   *  现状不读 fm `已发布`，published 判定在 units 组装时带出）。 */
  published: boolean
  /** （阶段 24）：分流呈现号（排序后赋值）——已发布章固定本地章号；其后未发布段
   *  从「已发布最大章号+1」按 sortKey 序位连续编（留洞制：合并/拆分产生的章号空洞在
   *  投稿分章前缀上闭合）。仅分章文件名前缀消费；全本/投稿视图/文案引用维持本地章号。 */
  displayNum?: number
}
/** （评审）：导出阶段结果——失败携错误文案（与该阶段原
 * 错误信封文案逐字一致）；写出段与投稿视图段另携已落盘产物快照（口径：
 *  split 项 ⟺ 已落盘、merged 名仅完整发布后列），其余阶段恒为 []。 */
export type StageResult<T> = { ok: true; value: T } | { ok: false; error: string; files?: string[] }

/** 导出运行态——跨阶段共享的可变状态（警告留痕 / 产物表 / 写出计数与
 *  实际产出章号集）。行为面与拆分前的同名局部变量逐位等价（警告文案求值时机不变）。
 *  导出供分段直测（测试自建 run 驱动单段）。 */
export interface ExportRun {
  readonly bookRoot: string
  readonly warnings: string[]
  readonly files: string[]
  writtenCount: number
  /** 实际产出章号集——投稿视图按它对齐（原经定稿预滤天然排除空正文章） */
  readonly writtenNums: Set<number>
}

/** 备目录段产物（写出段的落点与命名口径）——导出供分段直测。 */
export interface ExportPlan {
  exportDir: string
  /** 输出形态（写出段据此定扩展名/载荷/全本分隔） */
  output: ExportOutput
  /** 全本产物名（同名归档不下时就地改写为序号兜底名——写出段读改写后的值，勿缓存旧名） */
  mergedFileName: string
  /** 分章产物目录名（归档失败时为「分章-N」；不覆写原目录） */
  splitTargetDirName: string
  doMerged: boolean
  doSplit: boolean
  /** 定稿过滤后的可导出单元（收集 → 过滤 → 编号三段的结果，写出段按此序产出） */
  filtered: ExportUnit[]
}
