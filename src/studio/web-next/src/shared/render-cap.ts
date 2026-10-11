/**
 * 渲染上限单源：域内「只渲染前 N 条 + 尾部省略计数」共用件两枚——帽值 RENDER_CAP
 * 与切片/计数工具 capView。
 *
 * 口径：数据面不动（统计/计数/键表仍由调用方面向全量构造），只裁渲染面前 N 条 +
 * 尾部「已省略 N 条」提示行计数。切片与计数两式只此一处实现，调用方 import 取用，
 * 勿再手搓副本（帽值或式子复制一份即漂移：同帽不同口径、调帽漏改一处）。
 * ChapterTreeItem 的 active 贴尾滑窗是特例实现，不适用本工具；ShelfGrid 的 renderCap
 * 可缺省（undefined = 不裁）特判留调用方。
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
 * 域内渲染帽单源：列表类面板/弹层「只渲染前 N 条」的共用帽值。
 *
 * 为什么单源：帽值语义是「同族渲染面同一天花板」（内存核查口径——数百上千条 v-for
 * 节点在滚动容器里只被 max-height 裁视觉、节点照挂），各组件各写一份字面量时，
 * 调帽/改口径必漏改（同族两帽分叉即同屏两套截断行为，测试也钉不住）。
 * 消费面（capView / 贴尾滑窗 / 展开钮的步长与阈值）只 import 本常量，不得复制字面量。
 *
 * 保持独立、勿并入：SHELF_RENDER_CAP（书架按组帽，见下）、SampleCandidateList 的
 * 分组帽 50、AuditView 的跨页累积上限 2000——值与语义（分页累积 / 步长）均不同。
 */
export const RENDER_CAP = 100

/**
 * 书架渲染帽单源：浮层书架（ShelfModal）与整页书架
 * （pages/Shelf）两壳共用的每组渲染上限——原值只写在 ShelfModal 局部，整页不传
 * （「不传 = 不裁」）致两壳口径不一：数百书时整页全量挂载 + 入场动画，与浮层的
 * 同族性能论证相悖。收敛此处单一常量，两壳 import 同源，勿在壳内
 * 复制字面量（漂移即两帽口径分叉）。
 */
export const SHELF_RENDER_CAP = 100
