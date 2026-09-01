/**
 * R34D-10（三十四轮）回归：parseRealmSystems 三处键名冒号双认 `:`/`：`。
 *
 * 修复背景：`/^体系:\s*$/`、`- 名称:`、`序列:` 三处正则此前只认半角冒号，是
 * frontmatter 消费面唯一拒绝全角冒号的入口（parseFlat 的 firstKeyColon、
 * HISTORY_ENTRY_RE 均双认）——手写全角冒号的境界体系段整体解析为空，成长线机检失明。
 */
import { test, expect } from 'vitest'
import { parseRealmSystems, stringifyRealmSystems } from '../../src/format/frontmatter.js'

test('R34D-10: 全角冒号体系段完整解析（段头/名称/序列三处）', () => {
  const fmRaw = [
    '体系：',
    '  - 名称：修真境界',
    '    序列：[炼气, 筑基, 金丹]',
    '  - 名称：武者等级',
    '    序列：[后天, 先天]',
  ].join('\n')
  const systems = parseRealmSystems(fmRaw)
  expect(systems).toHaveLength(2)
  expect(systems[0]!.名称).toBe('修真境界')
  expect(systems[0]!.序列).toEqual(['炼气', '筑基', '金丹'])
  expect(systems[1]!.名称).toBe('武者等级')
  expect(systems[1]!.序列).toEqual(['后天', '先天'])
})

test('R34D-10: 全角/半角冒号混写仍解析', () => {
  const fmRaw = [
    '体系:', // 段头半角
    '  - 名称：修真境界', // 名称全角
    '    序列: [炼气, 筑基]', // 序列半角
  ].join('\n')
  const systems = parseRealmSystems(fmRaw)
  expect(systems).toHaveLength(1)
  expect(systems[0]!.名称).toBe('修真境界')
  expect(systems[0]!.序列).toEqual(['炼气', '筑基'])
})

test('R34D-10: 全角冒号解析结果与序列化回写往返', () => {
  const fmRaw = '体系：\n  - 名称：修真境界\n    序列：[炼气, 筑基]'
  const systems = parseRealmSystems(fmRaw)
  const text = stringifyRealmSystems(systems)
  // 写侧仍产出半角规范形态；再解析幂等
  expect(text).toContain('体系:')
  expect(parseRealmSystems(text)).toEqual(systems)
})
