/**
 * R26-86（二十六轮）：主窗口 bounds 恢复校验扩为「任一显示器包含即有效」。
 * 原口径只对主屏（getPrimaryDisplay）判定：多屏作者窗口常驻副屏，副屏坐标对主屏
 * 永远「越界」，恢复被无条件丢弃（尺寸/位置白丢）。纯函数直测，不依赖 Electron。
 */
import { describe, it, expect } from 'vitest'
import { isBoundsVisibleOnAnyDisplay, WIN_MIN_WIDTH, WIN_MIN_HEIGHT, BOUNDS_TOLERANCE, type WinRect } from '../../src/desktop/window-state.js'

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 }
const SECOND = { x: 1920, y: 0, width: 1920, height: 1080 } // 右侧副屏

describe('R26-86：isBoundsVisibleOnAnyDisplay', () => {
  it('常量口径锚定：最小尺寸 1200×600、容差 ±200（R1W-10 高度下限随小屏收口）', () => {
    expect(WIN_MIN_WIDTH).toBe(1200)
    expect(WIN_MIN_HEIGHT).toBe(600)
    expect(BOUNDS_TOLERANCE).toBe(200)
  })

  it('R1W-10：1366×768 小屏合法存档（高 720）恢复有效；600 以下仍按损坏丢弃', () => {
    const smallScreen = { x: 0, y: 0, width: 1366, height: 728 }
    expect(isBoundsVisibleOnAnyDisplay({ x: 0, y: 0, width: 1200, height: 700 }, [smallScreen])).toBe(true)
    expect(isBoundsVisibleOnAnyDisplay({ x: 0, y: 0, width: 1200, height: 500 }, [smallScreen])).toBe(false)
  })

  it('单屏：主屏内 bounds 有效；屏幕外/过小无效（原语义保留）', () => {
    expect(isBoundsVisibleOnAnyDisplay({ x: 50, y: 50, width: 1500, height: 900 }, [PRIMARY])).toBe(true)
    expect(isBoundsVisibleOnAnyDisplay({ x: 5000, y: 5000, width: 1500, height: 900 }, [PRIMARY])).toBe(false)
    expect(isBoundsVisibleOnAnyDisplay({ x: 0, y: 0, width: 300, height: 200 }, [PRIMARY])).toBe(false)
  })

  it('核心回归：窗口在副屏（主屏之外）→ 任一包含即有效（修复前对主屏判定恒丢弃）', () => {
    const onSecond = { x: 2000, y: 100, width: 1400, height: 900 }
    expect(isBoundsVisibleOnAnyDisplay(onSecond, [PRIMARY])).toBe(false) // 旧口径（仅主屏）= 误丢
    expect(isBoundsVisibleOnAnyDisplay(onSecond, [PRIMARY, SECOND])).toBe(true) // 新口径
  })

  it('多屏但真越界（所有屏之外）→ 仍丢弃（多屏拔除后坐标失效防线保留）', () => {
    expect(isBoundsVisibleOnAnyDisplay({ x: 5000, y: 5000, width: 1500, height: 900 }, [PRIMARY, SECOND])).toBe(false)
  })

  it('容差边界：轻微出界（≤200）有效，超容差无效（口径与拆分前一致）', () => {
    expect(isBoundsVisibleOnAnyDisplay({ x: -150, y: 0, width: 1500, height: 900 }, [PRIMARY])).toBe(true)
    expect(isBoundsVisibleOnAnyDisplay({ x: -250, y: 0, width: 1500, height: 900 }, [PRIMARY])).toBe(false)
  })

  // R28-20（二十八轮）：畸形 window-state.json 自守——修复前解构 `{x,y,width,height} =
  // bounds` 对非对象/缺字段直接 TypeError（靠 main.ts 外层 catch 兜底不崩），NaN/Infinity
  // 则静默参与比较。现入口校验四值均为有限数，非法一律按「不可恢复」语义返回 false
  // 丢弃恢复（与「过小视为损坏」同一出口），纯函数不再外抛。
  describe('R28-20：畸形 bounds 自守（不抛 TypeError，一律丢弃恢复）', () => {
    it('非对象（{"bounds":1} 形态）与 null → false', () => {
      expect(isBoundsVisibleOnAnyDisplay(1 as unknown as WinRect, [PRIMARY])).toBe(false)
      expect(isBoundsVisibleOnAnyDisplay(null as unknown as WinRect, [PRIMARY])).toBe(false)
    })

    it('缺字段（无 height）→ false', () => {
      const bad = { x: 50, y: 50, width: 1500 } as unknown as WinRect
      expect(isBoundsVisibleOnAnyDisplay(bad, [PRIMARY])).toBe(false)
    })

    it('NaN / Infinity 字段 → false（有限数校验，不静默参与比较）', () => {
      const nan = { x: Number.NaN, y: 0, width: 1500, height: 900 } as unknown as WinRect
      const inf = { x: 50, y: 50, width: Number.POSITIVE_INFINITY, height: 900 } as unknown as WinRect
      expect(isBoundsVisibleOnAnyDisplay(nan, [PRIMARY])).toBe(false)
      expect(isBoundsVisibleOnAnyDisplay(inf, [PRIMARY])).toBe(false)
    })

    it('对照：合法 bounds 不受自守影响（防线不误杀）', () => {
      expect(isBoundsVisibleOnAnyDisplay({ x: 50, y: 50, width: 1500, height: 900 }, [PRIMARY])).toBe(true)
    })
  })
})
