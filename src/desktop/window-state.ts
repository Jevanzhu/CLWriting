/**
 * 主窗口 bounds 恢复校验（纯函数，零 Electron 依赖——可单测）。
 *
 * 从 main.ts loadWinState 抽出——原校验只对主屏（getPrimaryDisplay）
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
 *  （win 平台专项）：高度下限 760→600——1366×768（win 最常见小屏，
 *  工作区 ≈728）上 760 下限把小屏合法存档判成「损坏」丢弃、窗口永远恢复不出；
 *  600 仍能拦住截断/手改的畸形值（创建侧下限由 main.ts 按工作区钳制配合）。宽度
 *  1200 不动（1366 宽工作区可容纳）。 */
export const WIN_MIN_WIDTH = 1200
export const WIN_MIN_HEIGHT = 600

/** 屏幕包含判定的容差（±200，拆分前口径原样保留——允许边框/任务栏轻微出界） */
export const BOUNDS_TOLERANCE = 200

/** 创建侧产品最小面（新窗/恢复窗不得小于此——保三栏布局不挤）。与 WIN_MIN_* 语义
 *  不同：WIN_MIN_* 是存档校验红线（有意更宽放，防历史小屏合法存档误丢）；本组是
 * 创建下限（main.ts minWidth/minHeight 与首启缺省共用小屏按工作区收口）。 */
export const CREATE_MIN_WIDTH = 1200
export const CREATE_MIN_HEIGHT = 760

/** 首启缺省尺寸的工作区占比——宽 0.6 / 高 0.8（作者定标：2K 屏 2560 宽取 1550 够用
 *  ≈0.6；高度写作面越大越好取 0.8）。随分辨率自适应，不同机器首开窗口比例一致。 */
export const DEFAULT_WIDTH_RATIO = 0.6
export const DEFAULT_HEIGHT_RATIO = 0.8

/**
 * bounds 是否落在任一给定显示器的可见区内（±容差）。
 * 尺寸红线先判（与显示器无关）；位置对 displays 逐个判包含，任一命中即有效。
 */
export function isBoundsVisibleOnAnyDisplay(
  bounds: WinRect,
  displays: readonly WinRect[],
  tolerance: number = BOUNDS_TOLERANCE,
): boolean {
  // 畸形输入自守——window-state.json 手改/截断出 {"bounds":1}、
  // 缺字段或 NaN 时，原解构 `{x,y,width,height} = bounds` 直接 TypeError（此前靠
  // main.ts 外层 catch 兜住不崩，但纯函数契约宜自守）。入口先校验 bounds 为非 null
  // 对象且四值均为有限数，非法一律按「不可恢复」语义返回 false 丢弃恢复——与
  // 「过小视为损坏」同一出口，函数不再外抛。
  if (typeof bounds !== 'object' || bounds === null) return false
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return false
  }
  const { x, y, width, height } = bounds
  // 宽度红线按显示器收口——创建侧 minWidth 取 Math.min(1200,
  // wa.width-8)、缺省宽按 defaultWindowSize（80% 工作区占比 + 上下钳制，见下），窄屏
  //（工作区 <1208px，如 1024×768）机器的合法存档（944px）此前被 1200 硬红线判「损坏」
  // 整体丢弃，窗口记忆永不生效（只收了高度侧下限常量，宽度侧漏）。红线放低到
  //「任一显示器可产出的最小合法宽」（wa.width-80：不高于窄屏 minWidth 下限与缺省宽，
  // 只拦真畸形；正常屏 ≥1280 时仍为 1200，行为不变）。位置越界 containment 判定照旧
  // 兜底；空 displays（理论不可达）维持 1200 原口径。
  const minAllowedWidth = displays.length
    ? Math.min(WIN_MIN_WIDTH, ...displays.map((wa) => Math.max(0, wa.width - 80)))
    : WIN_MIN_WIDTH
  // 高度红线同款收口（只收了宽度侧，高度仍 600 硬编码）——
  // 创建侧 minHeight = Math.min(760, wa.height-8)（main.ts），超小屏+高 DPI 缩放
  //（工作区 <608）上 600 硬红线把合法存档判「损坏」整体丢弃。红线放低到「任一显示器
  // 可产出的最小合法高」（wa.height-8 与创建侧下限口径一致；正常屏工作区 ≥608 时
  // 仍为 600，行为不变）；空 displays 维持 600 原口径。
  const minAllowedHeight = displays.length
    ? Math.min(WIN_MIN_HEIGHT, ...displays.map((wa) => Math.max(0, wa.height - 8)))
    : WIN_MIN_HEIGHT
  if (!(width >= minAllowedWidth && height >= minAllowedHeight)) return false
  return displays.some(
    (wa) =>
      x >= wa.x - tolerance &&
      y >= wa.y - tolerance &&
      x + width <= wa.x + wa.width + tolerance &&
      y + height <= wa.y + wa.height + tolerance,
  )
}

/**
 * 首启（无 window-state.json 存档）缺省窗口尺寸与创建下限——纯函数（零 Electron
 * 依赖，可单测；main.ts 主窗创建唯一消费点）。
 *
 * 口径（自适应取代旧「固定 1532×1237 + 小屏钳制」——旧定值即某台机器的工作区-80，
 * 换机失准）：
 * - 默认 = 宽 × DEFAULT_WIDTH_RATIO / 高 × DEFAULT_HEIGHT_RATIO——不同分辨率机器
 *   首开比例一致，大屏不再钉死定值；
 * - 上限 = 工作区 − 80px（四边留白，不贴边/压任务栏与 Dock——旧小屏兜底口径原样）；
 * - 下限 = min(CREATE_MIN_*, 工作区 − 8)（保三栏不挤；小屏按可用空间收口，
 * 先例同款余量）。
 * minWidth/minHeight 一并返回供创建入参（windows.ts 子窗 sizes 同形状，单源不双写）。
 */
export function defaultWindowSize(wa: { width: number; height: number }): {
  width: number
  height: number
  minWidth: number
  minHeight: number
} {
  const minWidth = Math.min(CREATE_MIN_WIDTH, wa.width - 8)
  const minHeight = Math.min(CREATE_MIN_HEIGHT, wa.height - 8)
  return {
    width: Math.max(minWidth, Math.min(Math.round(wa.width * DEFAULT_WIDTH_RATIO), wa.width - 80)),
    height: Math.max(minHeight, Math.min(Math.round(wa.height * DEFAULT_HEIGHT_RATIO), wa.height - 80)),
    minWidth,
    minHeight,
  }
}
