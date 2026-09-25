/**
 * 机检入口的兼容桥（'check/run.js' 既有 import 面）。
 *
 * R0916-7-P3-2（全项目源码质量与优雅度评审 P3-2/P3-3）：实现体两分——树红点聚合族在
 * run-tree-issues.ts（R0916-5f 拆出）、单章机检链与批量预扫在 run-single-doc.ts
 * （本批拆出，原为本文件正文）。两实现件都不引本文件，本文件只做具名 re-export，
 * 全库 'check/run.js' import 方零感知。
 *
 * 不变量（断环所系）：本文件**只许** re-export，不得再落任何实现——一旦在此实现，
 * 两个实现件之一回头取用即成新环（评审 P3-3 的 check/run ↔ check/run-tree-issues
 * 环即由「聚合侧取实现件 + 本文件反向 re-export 聚合族」构成）。
 */
export {
  collectTreeIssues,
  collectTreeIssuesAsync,
  __setLeadsBookDegradeForTest,
  __setChapterCheckDegradeForTest,
  __setOpenCheckDbAsyncForTest,
} from './run-tree-issues.js'

export {
  readCheckConfig,
  openCheckDb,
  openCheckDbAsync,
  getOpenCheckDbTtlForTest,
  __setOpenCheckDbTtlForTest,
  __resetRebuildDoneAtForTest,
  runCheckForDocument,
  runCheckForDocumentAsync,
  maxWrittenChapterOf,
  maxWrittenChapterOfCore,
  scanChapterUpdatesByChapter,
  scanChapterUpdatesByChapterCore,
  LEAD_UPDATES_SCAN_YIELD_EVERY,
  checkWithDb,
  checkWithDbCore,
  checkOutcomeStatus,
} from './run-single-doc.js'

export type {
  CheckOutcome,
  OpenCheckDbOpts,
  OpenCheckDbResult,
  BatchCheckContext,
} from './run-single-doc.js'
