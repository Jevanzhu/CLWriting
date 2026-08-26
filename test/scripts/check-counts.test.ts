/**
 * R63-12：check-counts 净化/计数/检出纯函数直测。
 *
 * check:counts 的 strip/计数正则历经 X-32、R62-56 两轮行为修改，此前零单测——
 * 口径改动只能靠 README 对账间接暴露。本文件锚定：剥注释/剥字符串语义、
 * e2e 用例计数口径（含 R62-56 补的 test.fail/test.fixme）、R63-12 新增的
 * 无条件 .skip 拒绝与条件式 skip 白名单豁免（对照 check-packaging 直测先例）。
 */
import { describe, it, expect } from 'vitest'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { stripComments, stripStrings, countE2eCases, findOnlyOrSkipViolations } from '../../scripts/check-counts.mjs'

describe('R63-12：净化口径（X-32 语义锚定）', () => {
  it('stripComments 剥行注释与块注释，保留 https:// 协议斜杠', () => {
    expect(stripComments('const a = 1 // 尾注\nconst b = 2')).toBe('const a = 1 \nconst b = 2')
    expect(stripComments('/* 块注 */ const a = 1')).toBe(' const a = 1')
    expect(stripComments('const u = "https://x.dev"')).toBe('const u = "https://x.dev"')
  })

  it('stripStrings 清空字符串内容但保留定界符（词法形态维持，空串可匹配）', () => {
    expect(stripStrings(`it('标题', () => {})`)).toBe(`it("", () => {})`)
    expect(stripStrings('const s = "test( 假用例";')).toBe('const s = "";')
    expect(stripStrings('`模板 ${x} 串`')).toBe('""')
  })
})

describe('R63-12：e2e 用例静态计数（含 R62-56 test.fail/test.fixme）', () => {
  it('数真实声明：test( / test.serial( / test.only( / test.fail( / test.fixme(', () => {
    const src = [
      "test('a', () => {})",
      "test.serial('b', async () => {})",
      "test.only('c', () => {})",
      "test.fail('d', () => {})",
      "test.fixme('e', () => {})",
    ].join('\n')
    expect(countE2eCases(src)).toBe(5)
  })

  it('排除 hook/describe 点后缀与注释/字符串里的样例声明（曾把 37 数成 56）', () => {
    const src = [
      'test.beforeAll(() => {})',
      'test.beforeEach(() => {})',
      "test.describe('组', () => {})",
      "test.describe.only('组only', () => {})",
      "// test('注释掉的用例', () => {})",
      `const doc = "说明：test( 写进字符串不算"`,
    ].join('\n')
    expect(countE2eCases(src)).toBe(0)
  })
})

describe('R63-12：.only / 无条件 .skip 拒绝门', () => {
  it('.only（it/test/describe）一律检出', () => {
    expect(findOnlyOrSkipViolations("it.only('x', () => {})")).toEqual({ only: 1, uncondSkip: 0 })
    expect(findOnlyOrSkipViolations('test.only(() => {})')).toEqual({ only: 1, uncondSkip: 0 })
    expect(findOnlyOrSkipViolations("describe.only('g', () => {})")).toEqual({ only: 1, uncondSkip: 0 })
    // 注释/字符串里的 .only 不误报（X-32 同口径）
    expect(findOnlyOrSkipViolations("// it.only('注释', () => {})")).toEqual({ only: 0, uncondSkip: 0 })
  })

  it('无条件 .skip（首参标题串）检出——调试遗留静默跳过即门禁假绿', () => {
    expect(findOnlyOrSkipViolations("it.skip('断网挂起的用例', () => {})")).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations("test.skip('跳过', () => {})")).toEqual({ only: 0, uncondSkip: 1 })
  })

  it('条件式 .skip（首参布尔表达式）白名单豁免——环境门是合法用法', () => {
    // release-smoke.spec.ts:21 的发布门先例：剥字符串后 `(` 后是 `!` 而非 `"`
    const src = "test.skip(!process.env['CLWRITING_E2E_RELEASE'], '发布 smoke')"
    expect(findOnlyOrSkipViolations(src)).toEqual({ only: 0, uncondSkip: 0 })
    // skipIf（playwright 条件跳过 API）不在射程——`.skip` 后跟 `If(` 不匹配
    expect(findOnlyOrSkipViolations("test.skipIf(!hasToken, '可选')")).toEqual({ only: 0, uncondSkip: 0 })
  })
})
