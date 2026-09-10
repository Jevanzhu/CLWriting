/**
 * R1010c-SRV-P3-1（2026-09-10 全量独立复审修复批）回归：
 * forceReleaseSelfHealRunning（生产命名导出，stream.ts 静默挂死 watchdog 二段强释放
 * 的登记清理入口）与测试别名 __setSelfHealRunningForTest(off) 行为一致。
 *
 * 背景：watchdog 强释放此前直调 __setSelfHealRunningForTest(bookName, false)——测试
 * 命名 API 进生产路径。修复后生产消费点改调 forceReleaseSelfHealRunning，别名保留为
 * off 分支转调新函数（零行为变更）。本用例钉住「新导出 ≡ 别名 off 路径」等价契约，
 * 防日后两处实现漂移（如强释放侧追加注销/留痕逻辑而别名漏同步）。
 *
 * 直调真实模块（无 mock）——运行登记正本 running Map 在模块级，用独立书名避免污染。
 */
import { describe, it, expect } from 'vitest'
import {
  forceReleaseSelfHealRunning,
  __setSelfHealRunningForTest,
  isSelfHealRunning,
} from '../../../src/ai/orchestrate/self-heal.js'

const BOOK = 'R1010c强释放一致性书'

describe('R1010c-SRV-P3-1：forceReleaseSelfHealRunning 与测试别名行为一致', () => {
  it('同一语义：登记 → 强释放清空，别名 off 与新导出互相等价（幂等）', () => {
    try {
      // 新导出：清在册登记
      __setSelfHealRunningForTest(BOOK, true)
      expect(isSelfHealRunning(BOOK)).toBe(true)
      forceReleaseSelfHealRunning(BOOK)
      expect(isSelfHealRunning(BOOK)).toBe(false)

      // 别名 off 路径：与新导出同一效果（内部转调同一 running.delete）
      __setSelfHealRunningForTest(BOOK, true)
      expect(isSelfHealRunning(BOOK)).toBe(true)
      __setSelfHealRunningForTest(BOOK, false)
      expect(isSelfHealRunning(BOOK)).toBe(false)

      // 幂等：重复强释放 / 不在册书强释放均安全（watchdog 二段与迟到 finally 同键互容的根基）
      forceReleaseSelfHealRunning(BOOK)
      forceReleaseSelfHealRunning('不在册的强释放书')
      expect(isSelfHealRunning(BOOK)).toBe(false)
      expect(isSelfHealRunning('不在册的强释放书')).toBe(false)
    } finally {
      // 兜底清场，防注入态泄漏到同进程其它用例
      forceReleaseSelfHealRunning(BOOK)
      __setSelfHealRunningForTest(BOOK, false)
    }
  })
})
