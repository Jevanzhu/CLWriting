/**
 * 主窗口 bounds 恢复校验（纯函数，零 Electron 依赖——可单测）。
 *
 * R26-86（二十六轮）：从 main.ts loadWinState 抽出——原校验只对主屏（getPrimaryDisplay）
 * 判定包含，多屏作者窗口常驻副屏：副屏坐标对主屏永远「越界」，恢复被无条件丢弃，
 * 窗口尺寸/位置白丢。扩为 getAllDisplays 任一显示器包含即有效（±容差口径原样保留）。
 */

/** 窗口/显示器矩形（screen.Display.bounds 同形状） */
export interface WinRect {
  x: number
  y: number
  width: number
  height: number
}

/** 最小可用尺寸（过小的存量视为损坏）。
 *  R1W-10（win 平台专项复审 R1）：高度下限 760→600——1366×768（win 最常见小屏，
 *  工作区 ≈728）上 760 下限把小屏合法存档判成「损坏」丢弃、窗口永远恢复不出；
 *  600 仍能拦住截断/手改的畸形值（创建侧下限由 main.ts 按工作区钳制配合）。宽度
 *  1200 不动（1366 宽工作区可容纳）。 */
export const WIN_MIN_WIDTH = 1200
export const WIN_MIN_HEIGHT = 600

/** 屏幕包含判定的容差（±200，拆分前口径原样保留——允许边框/任务栏轻微出界） */
export const BOUNDS_TOLERANCE = 200

/**
 * bounds 是否落在任一给定显示器的可见区内（±容差）。
 * 尺寸红线先判（与显示器无关）；位置对 displays 逐个判包含，任一命中即有效。
 */
export function isBoundsVisibleOnAnyDisplay(
  bounds: WinRect,
  displays: readonly WinRect[],
  tolerance: number = BOUNDS_TOLERANCE,
): boolean {
  // R28-20（二十八轮）：畸形输入自守——window-state.json 手改/截断出 {"bounds":1}、
  // 缺字段或 NaN 时，原解构 `{x,y,width,height} = bounds` 直接 TypeError（此前靠
  // main.ts 外层 catch 兜住不崩，但纯函数契约宜自守）。入口先校验 bounds 为非 null
  // 对象且四值均为有限数，非法一律按「不可恢复」语义返回 false 丢弃恢复——与
  // 「过小视为损坏」同一出口，函数不再外抛。
  if (typeof bounds !== 'object' || bounds === null) return false
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(
      (v) => typeof v === 'number' && Number.isFinite(v),
    )
  ) {
    return false
  }
  const { x, y, width, height } = bounds
  if (!(width >= WIN_MIN_WIDTH && height >= WIN_MIN_HEIGHT)) return false
  return displays.some(
    (wa) =>
      x >= wa.x - tolerance && y >= wa.y - tolerance &&
      x + width <= wa.x + wa.width + tolerance &&
      y + height <= wa.y + wa.height + tolerance,
  )
}
