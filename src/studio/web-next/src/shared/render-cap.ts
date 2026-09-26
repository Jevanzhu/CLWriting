/**
 * 渲染上限切片单源：RENDER_CAP 三件套
 * （`const RENDER_CAP = 100` + `arr.slice(0, CAP)` + `Math.max(0, arr.length - CAP)`）
 * 的收敛件——CommandPalette（内存核查口径）首立，RewritePanel/AuditDiffPanel
 * CheckPanel/ReviewPanel/ForeshadowPanel/TrashPanel、
 * ModelPicker（2-）、ShelfGrid、SampleCandidateList 各自
 * 手搓的同构切片此后换装本工具。
 *
 * 口径不变：数据面不动（统计/计数/键表仍由调用方面向全量构造），只裁渲染面前 N 条 +
 * 尾部「已省略 N 条」提示行计数。ChapterTreeItem 的 active 贴尾滑窗是特例实现，
 * 不适用本工具；ShelfGrid 的 renderCap 可缺省（undefined = 不裁）特判留调用方。
 */
export interface CappedView<T> {
  /** 渲染面前 cap 条（原 `arr.slice(0, cap)`） */
  view: T[]
  /** 窗口外条数（原 `Math.max(0, arr.length - cap)`，提示行展示） */
  omitted: number
}

export function capView<T>(arr: readonly T[], cap: number): CappedView<T> {
  return { view: arr.slice(0, cap), omitted: Math.max(0, arr.length - cap) }
}

/**
 * 书架渲染帽单源（0918二轮修复2）：浮层书架（ShelfModal）与整页书架
 * （pages/Shelf）两壳共用的每组渲染上限——原值只写在 ShelfModal 局部，整页不传
 * （「不传 = 不裁」）致两壳口径不一：数百书时整页全量挂载 + 入场动画，与浮层的
 * 同族性能论证相悖。收敛此处单一常量，两壳 import 同源，勿在壳内
 * 复制字面量（漂移即两帽口径分叉）。
 */
export const SHELF_RENDER_CAP = 100
