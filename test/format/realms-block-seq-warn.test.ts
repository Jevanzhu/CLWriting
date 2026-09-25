/**
 * R51-F-4（五十一轮）回归：parseRealmSystems 对块式序列 warn 留痕。
 *
 * 标准 YAML 手写形态（`序列:` 逐行 `- 项`）本解析器不支持（仅认流式 `[a, b]`）——
 * 此前整段静默失明（序列落空数组），成长线机检/注入对该体系失真无迹可查。
 * 修复：不支持仍不支持，但 warn 留痕（每次解析至多一条）；流式写法行为不变。
 */
import { test, expect, vi } from 'vitest'
import { parseRealmSystems } from '../../src/format/frontmatter.js'
import { log } from '../../src/log/index.js'

test('R51-F-4: 块式序列体系段 → 序列按空处理 + warn 留痕（每次解析至多一条）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const fmRaw = [
      '体系:',
      '  - 名称: 修真境界',
      '    序列:',
      '      - 炼气',
      '      - 筑基',
      '      - 金丹',
    ].join('\n')
    const systems = parseRealmSystems(fmRaw)
    // 不支持仍不支持：名称收到、序列为空（修复前后行为一致）
    expect(systems).toHaveLength(1)
    expect(systems[0]!.名称).toBe('修真境界')
    expect(systems[0]!.序列).toEqual([])
    // 修复点：warn 留痕（多行块内容 + 空值头共用去重闸，至多一条）
    const warns = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).filter((m) => m.includes('块式序列'))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('序列: [a, b]')
  } finally {
    warnSpy.mockRestore()
  }
})

test('R51-F-4: 多体系多块式段共用去重闸（不逐行刷屏）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const fmRaw = [
      '体系:',
      '  - 名称: 修真境界',
      '    序列:',
      '      - 炼气',
      '      - 筑基',
      '  - 名称: 武者等级',
      '    序列:',
      '      - 后天',
      '      - 先天',
    ].join('\n')
    const systems = parseRealmSystems(fmRaw)
    expect(systems).toHaveLength(2)
    expect(systems[1]!.序列).toEqual([])
    const warns = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).filter((m) => m.includes('块式序列'))
    expect(warns).toHaveLength(1) // 去重闸：一次解析至多 warn 一条
  } finally {
    warnSpy.mockRestore()
  }
})

test('R51-F-4: 流式写法行为不变且不触发 warn（warn 面不扩大）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const systems = parseRealmSystems('体系:\n  - 名称: 修真境界\n    序列: [炼气, 筑基]')
    expect(systems).toEqual([{ 名称: '修真境界', 序列: ['炼气', '筑基'] }])
    expect(warnSpy).not.toHaveBeenCalled()
  } finally {
    warnSpy.mockRestore()
  }
})
