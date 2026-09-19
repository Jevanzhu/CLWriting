/**
 * R63-12：check-counts 净化/计数/检出纯函数直测。
 *
 * check:counts 的 strip/计数正则历经 X-32、R62-56 两轮行为修改，此前零单测——
 * 口径改动只能靠 README 对账间接暴露。本文件锚定：剥注释/剥字符串语义、
 * e2e 用例计数口径（含 R62-56 补的 test.fail/test.fixme）、R63-12 新增的
 * 无条件 .skip 拒绝与条件式 skip 白名单豁免（对照 check-packaging 直测先例）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
// @ts-expect-error —— .mjs 直跑脚本无类型声明（不为其维护 d.ts；断言口径靠用例锚定）
import { stripComments, stripStrings, countE2eCases, findOnlyOrSkipViolations, sanitizeForCount, posixRelPath, findAssertionFreeTestFiles, missingPageErrorWiring, sharedRuntimeVersionDrift, walk } from '../../scripts/check-counts.mjs'

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

  // 0917清库修复批 AST 化：skip 门禁改 TypeScript AST 扫描——正则近似族的嵌套括号
  // 盲区（R0912-3 一层平衡括号近似，嵌套 ≥2 层 `)` 漏检向）随实现替换封死；对账
  // 口径与改前正则逐位一致（全树新旧实现逐文件 A/B 零差异），本用例钉死漏检形态
  // 与不扩大的射程边界。
  it('0917清库修复批 AST 化: skip.each/only.each 参数嵌套 ≥2 层括号不再漏检，射程不扩', () => {
    expect(
      findOnlyOrSkipViolations("it.skip.each(deep(build(1, (x) => x)))('深层参数化 %d', (n) => {})").uncondSkip,
    ).toBe(1)
    expect(findOnlyOrSkipViolations('test.only.each(gen(pairs(1, [2, (v) => v])))').only).toBe(1)
    // 射程与改前正则对齐：可选链形态、skipIf 平台门均不在射程
    expect(findOnlyOrSkipViolations("test?.skip('可选链形态不收', () => {})").uncondSkip).toBe(0)
    expect(findOnlyOrSkipViolations("test.skipIf(true, '平台门豁免口径不变')").uncondSkip).toBe(0)
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

  // 0918四轮修复批（G411）：漂移门默认清单扩 typescript——根 ^5.5.0 vs 子包 ^5.6.0
  // 声明范围漂移此前无门（两把 lock 实装失配时 tsc 门与 vite 构建消费不同编译器副本）。
  // 用默认清单跑（不传 pkgs）：typescript 不在清单时红例会返回 []，本用例即失败——
  // 清单回退与漂移检出同钉。
  it('G411: typescript 纳入默认对账——两 lock 同版绿 / 异版红（漂移消息含两侧版本）', () => {
    const lockWith = (v: string) => ({ 'node_modules/typescript': { version: v } })
    expect(sharedRuntimeVersionDrift(lockWith('5.9.3'), lockWith('5.9.3'))).toEqual([])
    expect(sharedRuntimeVersionDrift(lockWith('5.5.4'), lockWith('5.6.3'))).toEqual([
      'typescript: 根 5.5.4 ↔ web-next 5.6.3',
    ])
    // 射程不变：单侧缺失（如根不装 typescript 的形态）不报，与 vue-router 同口径
    expect(sharedRuntimeVersionDrift({}, lockWith('5.6.3'))).toEqual([])
  })
})

// vitest 5 升级批（阶段 39）：win/linux 平台门差值解析与分账反推判定直测组
//（parseWinPlatformDelta / parseLinuxPlatformDelta / problemsForWinUnitTestsClaim，
// 原 R0911-G-P3-1 + 2026-09-17 拍板快断批共 10 例）随静态口径废除一并移除——
// v5 list 静态抽取全平台同数，README 单测数回归四腿同一直读对账，无分账面可测。

// ── 0918独立重评修复批（D005）：walk symlink 防护 ──────────────────────────────
// 此前 walk 以 statSync 跟随 symlink + isDirectory 递归：目录环 symlink（a→b→a）令
// statSync 跟随撞内核 symlink 解析上限裸抛 ELOOP（mac 实测；非 walk 容错码 → 门脚本
// 整轮崩），未成环的 symlink 也被跟随下钻/收集（计数扩面）。修法 = lstatSync 判型
// 不跟随 + symlink 一律跳过（对齐 check-knowledge R71-39「环路/越界不可判」fail-safe
// 口径；本侧计数门选跳过不选拒绝——对账面只认实体树，vitest/coverage 收集同样不循
// symlink 扩面）。对照盲区钉样式：r50-f2 TOCTOU 容错同族（walk 的既有跳过面）。
describe('0918独立重评修复批 D005：check-counts walk symlink 防护（lstat 判型不跟随）', () => {
  let dirs: string[] = []
  function tmpDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'clw-d005-walk-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs = []
  })

  // Windows 无 symlink 常规权限（需开发者模式，symlinkSync 直建 EPERM），macOS/Linux CI 腿覆盖
  it.skipIf(process.platform === 'win32')('目录环 symlink：walk 不炸门（ELOOP 不再触达）、symlink 跳过、实体文件照常收集', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    const a = join(d, 'a')
    const b = join(d, 'b')
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(a, 'real.test.ts'), 'x')
    writeFileSync(join(b, 'plain.md'), 'y')
    // 环：a/loop → b，b/loop → a（修复前 walk(a) → statSync 跟随 loop → 撞内核 symlink
    // 上限裸抛 ELOOP 炸门，mac 实测）
    symlinkSync(b, join(a, 'loop'))
    symlinkSync(a, join(b, 'loop'))

    const out = walk(d, (n: string) => n.endsWith('.test.ts')).map((p: string) => p.split(sep).pop())
    expect(out).toEqual(['real.test.ts']) // 实体文件收齐，环未跟随、门不炸
  })

  it.skipIf(process.platform === 'win32')('断链 symlink 与指向文件/自指 symlink：一律跳过并 warn 留痕，其余条目不受影响', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    writeFileSync(join(d, 'keep.test.ts'), 'x')
    symlinkSync(join(d, 'gone-target'), join(d, 'broken.test.ts')) // 断链（目标不存在）
    symlinkSync(join(d, 'keep.test.ts'), join(d, 'file-link.test.ts')) // 指向文件（修复前会被收集，虚增计数）
    symlinkSync(d, join(d, 'self-loop')) // 自指目录环

    const out = walk(d, (n: string) => n.endsWith('.test.ts')).map((p: string) => p.split(sep).pop())
    expect(out).toEqual(['keep.test.ts']) // 三个 symlink 全跳过：断链不炸、文件链接不虚增、自指不下钻
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('symlink'))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('指向目录的 symlink 不下钻：目标子树实体文件不重复收集', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = tmpDir()
    const sub = join(d, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'inner.test.ts'), 'x')
    symlinkSync(sub, join(d, 'alias')) // alias → sub（修复前 alias 下钻把 inner 收两次）

    const out = walk(d, (n: string) => n.endsWith('.test.ts')).map((p: string) => p.split(sep).pop())
    expect(out).toEqual(['inner.test.ts']) // 仅实体路径一份，alias 不扩面
  })
})
