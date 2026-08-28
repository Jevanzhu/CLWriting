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
import { stripComments, stripStrings, countE2eCases, findOnlyOrSkipViolations, sanitizeForCount } from '../../scripts/check-counts.mjs'

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
    // R64-38（十二轮）：.only.each 组合形态——参数化组整组 only 化，此前正则漏放行
    expect(findOnlyOrSkipViolations("it.only.each([1, 2])('参数化 %d', (n) => {})")).toEqual({ only: 1, uncondSkip: 0 })
    expect(findOnlyOrSkipViolations('test.only.each([{ a: 1 }])')).toEqual({ only: 1, uncondSkip: 0 })
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

  it('R65-59（F-3）：无条件 .skip.each 参数化组检出——整组静默跳过同是门禁假绿', () => {
    expect(findOnlyOrSkipViolations("it.skip.each([1, 2])('参数化 %d', (n) => {})")).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations("test.skip.each([{ a: 1 }])('用例 %o', (v) => {})")).toEqual({ only: 0, uncondSkip: 1 })
    // 与 only 门同口径：注释/字符串里的形态不误报
    expect(findOnlyOrSkipViolations("// it.skip.each([1])('注释', (n) => {})")).toEqual({ only: 0, uncondSkip: 0 })
  })
})

describe('R73-78：模板串 ${} 嵌套净化（计数漂移防线）', () => {
  it('嵌套模板整体清成 ""——旧单条正则在嵌套反引号处提前截断、半截残留', () => {
    expect(stripStrings('const s = `a ${ t(`inner`) } b`;')).toBe('const s = "";')
  })

  it('${} 表达式内单双引号串里的反引号不算模板定界', () => {
    expect(stripStrings('`a ${ q["`"] } b`')).toBe('""')
    expect(stripStrings("`a ${ q['`'] } b`")).toBe('""')
  })

  it('多层嵌套与花括号平衡（对象字面量 + 嵌套模板含自身 ${}）', () => {
    expect(stripStrings('`a ${ JSON.stringify({ k: `n${x}` }) } b`')).toBe('""')
  })

  it('嵌套断裂不再虚增用例计数（旧口径把残留 `test(` 数成真用例 → 漂移为 2）', () => {
    // 旧正则：第一对反引号在嵌套模板前闭合，残留片段中的 `test(` 被数成真用例
    const src = 'const s = `x ${ tag(`test(`) } y`;\ntest(\'真用例\', () => {})'
    expect(countE2eCases(src)).toBe(1)
  })

  it('未闭合模板原样保留（与旧正则「不匹配未闭合串」口径一致）', () => {
    expect(stripStrings('const s = `unclosed')).toBe('const s = `unclosed')
  })
})

describe('R65-63（F-11）：sanitizeForCount 先清字符串后剥注释', () => {
  it('字符串内非冒前 // 不再吞行——行尾真实用例声明完整保留', () => {
    const src = "const t = 'data:aa//bb==';\ntest.serial('真实用例', () => {})"
    // 反序（旧口径）：字符串内 // 被当注释吃掉，串到行尾连真用例一起消失
    expect(sanitizeForCount(src)).not.toContain('data:aa')
    expect(countE2eCases(src)).toBe(1)
  })

  it('注释里成对反引号模板不污染跨行计数', () => {
    const src = "// 用法：把 `test(` 写进注释不计数\ntest('真用例', () => {})"
    expect(countE2eCases(src)).toBe(1)
  })

  it('.only/.skip 探测与两版净化的兼容锚（标题串占位为 ""）', () => {
    expect(findOnlyOrSkipViolations("it.skip('挂起的用例', () => {})")).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations("test.only('x', () => {})")).toEqual({ only: 1, uncondSkip: 0 })
    // 协议双斜杠在旧/新口径下均不被误剥（[^:] 守卫 + 先空串双保险）
    const src = "const BASE = `http://127.0.0.1:${PORT}`\ntest('x', () => {})"
    expect(countE2eCases(src)).toBe(1)
  })
})
