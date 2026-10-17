/**
 * 导出域 re-export 桥（'export/index.js' 既有 import 面）。
 *
 * 实现体分档：类型 types.ts / 净化 purify.ts / 命名与归档 naming.ts /
 * 前三阶段 collect.ts / 入口编排 book.ts / 备目录与写出 layout.ts / 投稿视图 submission.ts。
 * 实现件都不引本文件，本文件只做具名 re-export——全库 import 方零感知。
 *
 * 不变量（断环所系）：本文件只许 re-export，不得再落任何实现——一旦在此实现，
 * 实现件之一回头取用即成新环（同 check/run.ts 的桥接纪律）。
 */
export type {
  ExportFormat,
  ExportPlatform,
  ExportOutput,
  ExportOptions,
  ExportResult,
  ExportUnit,
  ExportRun,
  ExportPlan,
} from './types.js'

export { exportBook } from './book.js'

export { collectExportUnits, filterFinalizedUnits, orderAndNumberUnits, readUnitBody } from './collect.js'

export { prepareExportLayout, writeExportProducts } from './layout.js'

export { writeSubmissionView } from './submission.js'
