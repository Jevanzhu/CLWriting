import { EditorSelection } from '@codemirror/state'

/**
 * 同文档外部全量替换的选区映射（纯函数，CmHost.applyExternalReplace 与回归测试
 * 共用单源——R50-D1-3 行为化的代码移动，前端行为逐位不变）。
 *
 * R62-18：全区间替换会把光标映射到文末——阅读中间章节的用户被 SSE sync/refresh
 * 拽到底部。替换前记 head，替换后 clamp 归位到原位置（越界→文末）。
 * R50-D1-3（五十轮）：原实现只存 main.head 单点——活动选区（anchor≠head）与多光标
 * 在全量替换后坍缩为单光标。改为替换前保存完整 selection.ranges（各 range 的
 * anchor/head + mainIndex），替换后逐点按 R62-18 同款「归位原位置」语义映射
 *（min(pos, v.length) 逐点 clamp 到 [0, v.length]）重建 Selection。不经
 * changes.desc.mapPos：全区间替换下 mapPos 对被替换区间内任意位置一律映射到边界
 *（0 或 v.length），会回归 R62-18 的单光标归位语义；min-clamp 即该语义的逐点推广，
 * 单光标路径与原 Math.min(prevHead, v.length) 完全一致（回归测试钉死），多光标/
 * 非空选区的 ranges 数、anchor/head 方向与主 range 顺序语义保持。
 */
export function mapSelectionForFullReplace(prev: EditorSelection, v: string): EditorSelection {
  const len = v.length
  const ranges = prev.ranges.map((r) => EditorSelection.range(Math.min(r.anchor, len), Math.min(r.head, len)))
  return EditorSelection.create(ranges, prev.mainIndex)
}
