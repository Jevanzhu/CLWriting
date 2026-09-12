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
import { stripComments, stripStrings, countE2eCases, findOnlyOrSkipViolations, sanitizeForCount, posixRelPath, findAssertionFreeTestFiles, missingPageErrorWiring, sharedRuntimeVersionDrift, parseWinPlatformDelta, problemsForWinUnitTestsClaim } from '../../scripts/check-counts.mjs'

describe('J0（win 适配）：posixRelPath 分隔符归一化', () => {
  it('Windows 反斜杠绝对路径归一为 posix 相对路径——R66-37 快照守卫 win 假红根因', () => {
    // win 形态：walk 产出带盘符反斜杠的绝对路径，剥 root 后须归一为 posix 相对路径
    expect(posixRelPath('C:\\repo\\', 'C:\\repo\\test\\e2e\\a.spec.ts')).toBe('test/e2e/a.spec.ts')
    expect(posixRelPath('G:\\02^Workspace\\repo\\', 'G:\\02^Workspace\\repo\\test\\e2e\\b.spec.ts')).toBe('test/e2e/b.spec.ts')
    // posix 形态原样通过（mac/linux 不回归）
    expect(posixRelPath('/home/u/repo/', '/home/u/repo/test/e2e/c.spec.ts')).toBe('test/e2e/c.spec.ts')
    // 快照语义：归一化后与 posix 快照名单可互相命中
    expect(['test/e2e/a.spec.ts']).toContain(posixRelPath('C:\\repo\\', 'C:\\repo\\test\\e2e\\a.spec.ts'))
  })

  it('重评-P3-24①：root 无尾分隔符 → 入口归一补分隔符，剥根不残留前导 /', () => {
    // 修复前：replace(root) 剥出 '/test/e2e/…'（前导 / 残留）→ 快照比对假红；
    // 正确性此前隐性依赖调用面 URL('..') 自带尾分隔符
    expect(posixRelPath('/home/u/repo', '/home/u/repo/test/e2e/c.spec.ts')).toBe('test/e2e/c.spec.ts')
    // win 形态：root 含 `\` 缺尾分隔符时按 win 口径补 `\`（walk 产出平台原生分隔符）
    expect(posixRelPath('C:\\repo', 'C:\\repo\\test\\e2e\\a.spec.ts')).toBe('test/e2e/a.spec.ts')
    // 既有带尾分隔符口径不回归（posix 与 win 各锚一个）
    expect(posixRelPath('/home/u/repo/', '/home/u/repo/test/e2e/c.spec.ts')).toBe('test/e2e/c.spec.ts')
    expect(posixRelPath('C:\\repo\\', 'C:\\repo\\test\\e2e\\a.spec.ts')).toBe('test/e2e/a.spec.ts')
  })
})

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

  // R0912-3（2026-09-12 全量重评 #48）：each 参数改一层平衡括号近似——原 `\([^)]*\)` 遇
  // 参数内 `)` 提前收口，后随 `\s*\(\s*"` 失配 → 整组无条件 skip 漏检（R31-35 正则盲区
  // 同族，漏检向）。既有形态（数组参数/无第二调用）不回退。
  it('R0912-3: skip.each 参数内嵌套 `)`（如 each(buildPairs(1, 2))）不漏检', () => {
    expect(
      findOnlyOrSkipViolations("it.skip.each(buildPairs(1, 2))('参数化 %d', ([a, b]) => { expect(a).toBe(b) })"),
    ).toEqual({ only: 0, uncondSkip: 1 })
    // 参数内多处嵌套（map/filter 链）同样命中
    expect(
      findOnlyOrSkipViolations("test.skip.each(Object.keys(m).filter(f))('用例 %s', (k) => {})").uncondSkip,
    ).toBe(1)
    // 既有形态不回退：数组参数照旧；无第二调用（非标题串形态）不误报
    expect(findOnlyOrSkipViolations("it.skip.each([1, 2])('参数化 %d', (n) => {})").uncondSkip).toBe(1)
    expect(findOnlyOrSkipViolations('test.skip.each(cases)').uncondSkip).toBe(0)
  })

  it('R27-134: 零参形态 test.skip() 同样检出——连条件都没有的无条件跳过，比标题串更赤裸', () => {
    expect(findOnlyOrSkipViolations('test.skip()')).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations('it.skip( )')).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations('describe.skip()')).toEqual({ only: 0, uncondSkip: 1 })
    // 条件式豁免口径不受影响：`(` 后非引号/非右括号仍是环境门（首参布尔表达式）
    expect(findOnlyOrSkipViolations("test.skip(!process.env['X'], '门')")).toEqual({ only: 0, uncondSkip: 0 })
    // 注释/字符串里的零参形态不误报（sanitize 同源口径）
    expect(findOnlyOrSkipViolations('// test.skip()')).toEqual({ only: 0, uncondSkip: 0 })
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
    // 协议双斜线在旧/新口径下均不被误剥（[^:] 守卫 + 先空串双保险）
    const src = "const BASE = `http://127.0.0.1:${PORT}`\ntest('x', () => {})"
    expect(countE2eCases(src)).toBe(1)
  })
})

describe('R76-40：空洞测试门（数断言不数声明）', () => {
  it('正常测试文件（含 expect 调用）不命中', () => {
    const entries = [{ relPath: 'test/a.test.ts', src: "it('x', () => { expect(1).toBe(1) })" }]
    expect(findAssertionFreeTestFiles(entries)).toEqual([])
  })

  it('只声明用例零断言的空洞文件命中——剥注释/字符串后判定', () => {
    // 用例体为空 / 断言只写进字符串或注释（样例文案）都不算真断言
    const hollow = [
      "describe('g', () => {",
      "  it('空壳', () => {})",
      "})",
      "const doc = 'expect(1).toBe(1)'",
      "// expect(x) 注释样例",
    ].join('\n')
    expect(findAssertionFreeTestFiles([{ relPath: 'test/hollow.test.ts', src: hollow }])).toEqual([
      'test/hollow.test.ts',
    ])
  })

  it('node:assert 形态（assert( / assert.equal(）同样认作断言面', () => {
    expect(findAssertionFreeTestFiles([{ relPath: 'test/n.test.ts', src: 'assert.equal(1, 1)' }])).toEqual([])
    expect(findAssertionFreeTestFiles([{ relPath: 'test/n2.test.ts', src: 'assert(true)' }])).toEqual([])
  })
})

describe('R76-6：e2e pageerror 接线静态门', () => {
  it('接了 attachPageErrorBaseline( 调用的 spec 不命中（import 行不带括号不算）', () => {
    const wired = [
      "import { attachPageErrorBaseline } from './page-error-baseline'",
      "test('x', async ({ page }) => {",
      "  attachPageErrorBaseline(page, 'x')",
      "})",
    ].join('\n')
    expect(missingPageErrorWiring([{ relPath: 'test/e2e/x.spec.ts', src: wired }])).toEqual([])
  })

  it('未接线的 spec 命中——注释/字符串里的接线样例不算（sanitizeForCount 同源）', () => {
    const unwired = [
      "// 记得 attachPageErrorBaseline(page, 'x')",
      "const s = 'attachPageErrorBaseline('",
      "test('x', async ({ page }) => { await page.goto('/') })",
    ].join('\n')
    expect(missingPageErrorWiring([{ relPath: 'test/e2e/y.spec.ts', src: unwired }])).toEqual([
      'test/e2e/y.spec.ts',
    ])
  })

  it('豁免名单（无浏览器页面的 spec）跳过——显式登记制', () => {
    const unwired = "test('x', () => {})"
    expect(
      missingPageErrorWiring(
        [{ relPath: 'test/e2e/release-smoke.spec.ts', src: unwired }],
        ['test/e2e/release-smoke.spec.ts'],
      ),
    ).toEqual([])
  })
})

// R54-E-3（五十四轮）：常量真值形态补拒——`test.skip(true)` 语法上是条件式（首参
// 非 `"`/`)`），语义上恒跳过（比零参更隐蔽的门禁假绿面）；`skip(false)` 恒跑无
// 门禁风险不收，环境门表达式（`!process.env.X` 等）照旧豁免。
describe('R54-E-3: 常量真值 test.skip(true) 检出', () => {
  it('skip(true) 各家族检出；skip(false)/真表达式/前缀变量不误伤', () => {
    expect(findOnlyOrSkipViolations("test.skip(true, '恒跳过')")).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations('test.skip(true)')).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations("it.skip(true, '恒跳过')")).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations("describe.skip(true, 'g')")).toEqual({ only: 0, uncondSkip: 1 })
    expect(findOnlyOrSkipViolations('test.skip(  true )')).toEqual({ only: 0, uncondSkip: 1 })
    // skip(false) 恒跑（无门禁风险）；环境门与真表达式首参照旧豁免
    expect(findOnlyOrSkipViolations("test.skip(false, '占位')")).toEqual({ only: 0, uncondSkip: 0 })
    expect(findOnlyOrSkipViolations("test.skip(!process.env['X'], '环境门')")).toEqual({ only: 0, uncondSkip: 0 })
    // `true` 前缀不误伤真变量（trueish 无词边界）
    expect(findOnlyOrSkipViolations('test.skip(trueish, "x")')).toEqual({ only: 0, uncondSkip: 0 })
  })
})

// R1010c-TL-P2-2（2026-09-10 全量独立复审修复批）：双包共享运行时版本对账纯函数直测——
// 修复前 vue 已实际漂移（根 3.5.38 ↔ 子包 3.5.40）无任何门会红；本门防再漂。
describe('R1010c-TL-P2-2: sharedRuntimeVersionDrift 双包共享运行时对账', () => {
  const rootLock = { 'node_modules/vue': { version: '3.5.42' }, 'node_modules/pinia': { version: '3.0.4' }, 'node_modules/@vitejs/plugin-vue': { version: '6.0.8' } }

  it('两侧齐备且版本一致 → 无漂移', () => {
    const webLock = { 'node_modules/vue': { version: '3.5.42' }, 'node_modules/pinia': { version: '3.0.4' }, 'node_modules/@vitejs/plugin-vue': { version: '6.0.8' } }
    expect(sharedRuntimeVersionDrift(rootLock, webLock)).toEqual([])
  })

  it('同包异版 → 逐项报漂移（含包名与两侧版本）', () => {
    const webLock = { 'node_modules/vue': { version: '3.5.40' }, 'node_modules/pinia': { version: '3.0.4' }, 'node_modules/@vitejs/plugin-vue': { version: '6.0.8' } }
    expect(sharedRuntimeVersionDrift(rootLock, webLock)).toEqual(['vue: 根 3.5.42 ↔ web-next 3.5.40'])
  })

  it('单侧缺失不报（vue-router 刻意只存子包：vitest alias 直钉 web-next 副本）', () => {
    const webLock = { ...rootLock, 'node_modules/vue-router': { version: '4.6.4' } }
    expect(sharedRuntimeVersionDrift(rootLock, webLock)).toEqual([])
  })

  it('双侧缺失同跳过；packages 形状缺键不炸（空键安全）', () => {
    expect(sharedRuntimeVersionDrift({}, {})).toEqual([])
    expect(sharedRuntimeVersionDrift({ 'node_modules/vue': {} }, { 'node_modules/vue': {} })).toEqual([])
  })
})

// ── R0911-G-P3-1（2026-09-11 全量重评 GLM-5.3 修复批）：win 腿单测数对账分支直测 ──
// parseWinPlatformDelta（README「实测差 N 恒定」原文解析）与 win 反推失配判定
// 此前只活在 main() 闭包里，win 腿红绿是唯一暴露通道（本地 mac 从不经过）。
describe('R0911-G-P3-1：win 平台门跳过量解析（README 唯一真相源的就地解析）', () => {
  it('标准表述 → 解析出数字', () => {
    expect(parseWinPlatformDelta('…win 实跑口径：… 实测差 75 恒定〔73 既有 + …〕')).toBe(75)
    expect(parseWinPlatformDelta('实测差 1 恒定')).toBe(1)
  })
  it('空白容忍（多空格）照解析；无该口径 / 非数字 → null（调用方 fail-closed 报红）', () => {
    expect(parseWinPlatformDelta('实测差  42  恒定')).toBe(42)
    expect(parseWinPlatformDelta('README 里没有这个口径')).toBe(null)
    expect(parseWinPlatformDelta('实测差 恒定')).toBe(null)
    expect(parseWinPlatformDelta('')).toBe(null)
  })
})

describe('R0911-G-P3-1：win 单测数反推失配判定（期望 win = 声称 − 平台门差）', () => {
  it('实测恰等于反推期望 → 无失配', () => {
    expect(problemsForWinUnitTestsClaim(6725, 75, 6650, '徽章单测数')).toEqual([])
  })
  it('win 实测偏少（收集丢失方向）→ 一条人话失配，含期望值与修账指引', () => {
    const problems = problemsForWinUnitTestsClaim(6725, 75, 6640, '徽章单测数')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('期望 win 6650')
    expect(problems[0]).toContain('实测 win 6640')
    expect(problems[0]).toContain('实测差 N 恒定')
  })
  it('win 实测偏多（README 漂移方向，如新增 skipIf 用例未修账）→ 同样红', () => {
    const problems = problemsForWinUnitTestsClaim(6725, 75, 6660, 'npm test 单测数')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('README 漂移或 win 侧收集丢失')
  })
  it('delta=0（无平台门差）退化为严格相等判定', () => {
    expect(problemsForWinUnitTestsClaim(100, 0, 100, 'x')).toEqual([])
    expect(problemsForWinUnitTestsClaim(100, 0, 99, 'x')).toHaveLength(1)
  })
})
