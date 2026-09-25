/**
 * 树红点聚合的纯决策件 —— R0916-7-P3-2（全项目源码质量与优雅度评审 P3-2）：
 * collectTreeIssuesCore 原把「清单折叠索引 / 章级条目合并 / 待落盘入列闸」三类判定
 * 内联在同一个生成器里，IO 与判定交织、无从直测。本件承载其中的纯判定（无 IO、
 * 无模块状态），聚合生成器只做遍历与副作用，判定口径逐位保留。
 *
 * 依赖方向不变量：只依赖 document/fs 层类型与 docJoinKey，**不得**引 run / runner /
 * run-tree-issues（否则又把聚合件拉回依赖面）。
 */
import type { ManifestEntry } from '../document/manifest.js'
import type { DocumentStatus } from '../document/status.js'
// R42-5（四十二轮）：join 键折叠（win32 大小写 + NFC）——盘上扫描路径与清单登记路径
// 仅大小写/组合形异时仍可追溯；索引侧与查询侧必须同键
import { docJoinKey } from '../fs/safe-path.js'

/** 章级红点条目（聚合结果值形状；仅含有 issue 的 docId 才入表）。 */
export interface TreeIssueEntry {
  hasRed: boolean
  verdictRejected: boolean
}

/**
 * 章级条目合并——缓存命中路与现算路同口径（唯一差异是 hasRed 的来源）：
 * 展示值 = 章作用域红 ∨ 账本全书性红（H-1 拆分后全书性红项不进章级缓存行，
 * 只在展示层合并）；两侧皆假且无 verdict 驳回 → 不入表（返回 null）。
 * 入表判定「mergedRed || verdictRejected」是「树红点只记有 issue 的 docId」契约的落点。
 */
export function treeIssuesChapterEntry(
  hasRed: boolean,
  verdictRejected: boolean,
  leadsBookRed: boolean,
): TreeIssueEntry | null {
  const mergedRed = hasRed || leadsBookRed
  return mergedRed || verdictRejected ? { hasRed: mergedRed, verdictRejected } : null
}

/** 待落盘章缓存行的入列信号（四闸全真才入列）。 */
export interface ChapterCacheRowSignals {
  /** 本轮章机检失败（瞬态异常）——失败行不落缓存，防把「未检出」固化成假阴性 */
  checkFailed: boolean
  /** 章级缓存可用（表在位 + 纪元同步成功） */
  cacheEnabled: boolean
  /** 本轮持库句柄 */
  hasDb: boolean
  /** 轮基线纪元指纹在位（epochFp0 非 null）——缺失一律按 miss，宁重算勿混纪元 */
  hasEpochBaseline: boolean
}

/**
 * A1/R70-14/R32-14：待落盘章缓存行入列闸。四信号缺一不列：
 * 机检失败不落（假阴性固化）、缓存不可用不落（无表/纪元同步失败）、无库句柄不落、
 * 纪元基线缺席不落（双进程并发下按他进程新纪元误读旧行）。
 */
export function shouldQueueChapterCacheRow(s: ChapterCacheRowSignals): boolean {
  return !s.checkFailed && s.cacheEnabled && s.hasDb && s.hasEpochBaseline
}

/** docId → 折叠 join 键（清单登记路径侧）：树聚合页的 docId 反查表。 */
export function indexManifestByPath(manifest: Map<string, ManifestEntry>): Map<string, string> {
  const pathToDocId = new Map<string, string>()
  for (const [docId, m] of manifest) pathToDocId.set(docJoinKey(m.path), docId)
  return pathToDocId
}

/** 折叠 join 键 → 清单条目（定稿态跳过判定用；与 indexManifestByPath 同键空间）。 */
export function indexEntriesByPath(manifest: Map<string, ManifestEntry>): Map<string, ManifestEntry> {
  const entryByPath = new Map<string, ManifestEntry>()
  for (const m of manifest.values()) entryByPath.set(docJoinKey(m.path), m)
  return entryByPath
}

/**
 * 定稿态派生（#6：published 判定走 stat 级探针，惰性求值）——探针只在 base 为 'final'
 * 时问一次（final 以外无 published 面）；探针经参数传入而非就地调用，判定可直测。
 */
export function treeChapterAggregationStatus(
  base: DocumentStatus,
  probePublished: () => boolean,
): DocumentStatus {
  return base === 'final' && probePublished() ? 'published' : base
}

/**
 * 定稿态跳过：final/published = 作者已确认，不参与树红点聚合（跳过机检 + verdict 检查；
 * 作者仍可在 CheckPanel 单章主动查看机检）。列表外状态（draft/revision/idea/archived）
 * 照常入列。
 */
export function skipsTreeRedDot(status: DocumentStatus): boolean {
  return status === 'final' || status === 'published'
}
