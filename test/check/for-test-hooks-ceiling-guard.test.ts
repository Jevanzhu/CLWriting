/**
 * 重评-0914-三轮 P3-14：src 全树「生产面 __…ForTest 导出钩子」数量守卫。
 *
 * 背景：src 全树散布 `__…ForTest` 导出钩子（内部态观测钩子 / 注入桩 / 时点披露），
 * 此前无集中清单亦无数量防线——无意识新增零成本，生产面测试后门悄然增殖。
 *
 * 计数口径 = **生产面导出声明式**，两条形并按钩子名去重：
 *   ① 裸导出形：行首 `export (async )?(function|const) __…ForTest`——定义即导出；
 *   ② 再导出声明形：行首单行 `export { __…ForTest, … }`——把已存在的钩子（工厂元组的
 *      setter 等）单独挂上导出面，如 src/git/exec.ts 的 `__setGitAsyncTimeoutForTest`。
 * 去重理由：一个后门 = 一个名字（定义 + 再导出是同一处后门，如 state.ts 转出 health.ts
 * 的 `__resetSweepThrottleForTest` 与 health.ts 的定义同属一处）。
 *
 * 口径边界（明示，防误信）：`testableConst` 工厂解构形（`export const [getter,
 * __setterForTest] = testableConst(…)`）不进本表——该形是收编目标形态（生产写入/读取与
 * 测试注入走同一元组，模块面无裸可变量），其 setter 单独挂 `export { }` 时按 ② 计入。
 *
 * 上岗与收窄沿革（数字留因）：守卫落地批（重评-0914-三轮 P3-14）实测 71；收编批把裸
 * 函数形收进 testableConst 工厂后，按上列口径实计 17。原锚 71 是收编批刻意留的上锚，
 * 余量 4.4 倍 —— 等于门失去拦截力（可静默容纳 54 处新后门）。现重设 20 = 17 + ≤3 余量：
 * 余量只给「确属测试必需的小批新增」，第 4 处起即红，逼有意抬锚并留因。
 *
 * 架构门注记（P3-5 行为化批次）：本文件对 src 源码做正则计数，属「仓内不得再出现」
 * 型负向扫描治理门（同族先例 = test/governance/runtime-import-cycles、封装锚、
 * check-module-ring）——被测对象就是「生产源码里测试后门的存量上限」这一源码级事实，
 * 行为断言不可替代（钩子导出不存在可观察的运行时行为面）。保留，非源码文本断言债务。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

/** 在锚值：口径实测 17 + ≤3 余量（见头注沿革——71 是收编批的上锚，余量 4.4 倍已失效）。 */
const FOR_TEST_HOOK_CEILING = 20

const HOOK_DEF_RE = /^export (?:async )?(?:function|const) (__[A-Za-z0-9_]+ForTest)\b/gm
const HOOK_DECL_RE = /^export \{([^}\n]*)\}/gm
const HOOK_NAME_RE = /__[A-Za-z0-9_]+ForTest\b/g

/** 命名形钩子名收集（口径两条形 + 去重），供全树扫描与口径回归用例共用。 */
function collectHookNames(text: string, into: Set<string> = new Set<string>()): Set<string> {
  for (const m of text.matchAll(HOOK_DEF_RE)) into.add(m[1]!)
  for (const m of text.matchAll(HOOK_DECL_RE)) {
    for (const name of m[1]!.match(HOOK_NAME_RE) ?? []) into.add(name)
  }
  return into
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue // 守卫口径：只数产品源码
    const p = join(dir, e.name)
    if (e.isDirectory()) collectSourceFiles(p, out)
    else if (/\.(ts|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('重评-0914-三轮 P3-14：__ForTest 导出钩子数量守卫', () => {
  it('src 全树 ForTest 导出钩子不超在锚（超限须有意抬锚）', () => {
    const names = new Set<string>()
    for (const f of collectSourceFiles(SRC_ROOT)) collectHookNames(readFileSync(f, 'utf-8'), names)
    expect(
      names.size,
      `src 全树 __…ForTest 导出钩子实测 ${names.size} 处（按名去重）> 在锚 ${FOR_TEST_HOOK_CEILING}。` +
        '新增生产面测试后门须有意抬锚并留因（口径见本档头注）。',
    ).toBeLessThanOrEqual(FOR_TEST_HOOK_CEILING)
  })

  it('口径回归：两条计数形各自成条，同名的定义 + 再导出只算一处', () => {
    // ① 裸导出形（三种声明关键字）
    expect([...collectHookNames('export function __aForTest(): void {}')]).toEqual(['__aForTest'])
    expect([...collectHookNames('export async function __bForTest(): Promise<void> {}')]).toEqual(['__bForTest'])
    expect([...collectHookNames('export const __cForTest = 1')]).toEqual(['__cForTest'])
    // ② 再导出声明形（工厂元组的 setter 单独挂导出面）
    expect([...collectHookNames('const [getTtl, __dForTest] = testableConst(0)\nexport { __dForTest }')]).toEqual([
      '__dForTest',
    ])
    // 去重：同名的定义 + 再导出是一处后门
    expect([...collectHookNames('export { __eForTest, other }\nexport function __eForTest(): void {}')]).toEqual([
      '__eForTest',
    ])
    // 多命名导出同行只取 ForTest 名，正常导出名不入账
    expect([...collectHookNames('export { plainName, __fForTest, otherForTest }')]).toEqual(['__fForTest'])
    // 口径边界：工厂解构形不进本表（未挂再导出声明）
    expect([...collectHookNames('export const [getTtl, __gForTest] = testableConst(0)')]).toEqual([])
    // 非行首（缩进 / 缩在块内）不算——生产面导出声明只在行首
    expect([...collectHookNames('  export function __hForTest(): void {}')]).toEqual([])
  })
})
