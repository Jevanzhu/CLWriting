/**
 * 重评-0914-三轮 P3-14：src 全树 `__xxxForTest` 导出测试钩子数量守卫。
 *
 * 背景：src 全树散布 71 处（2026-09-14 实测，守卫口径见下）`__…ForTest` 导出钩子
 * （内部态观测钩子 / 注入桩 / 时点披露），此前无集中清单亦无数量防线——无意识新增
 * 零成本，生产面测试后门悄然增殖。本测试以 node:fs 递归扫描 src 下 *.ts/*.vue
 * （跳过 node_modules 与 dist），统计行首 `export (async )?function|const __…ForTest`
 * 形态数量，断言不超过在锚值。超限须有意抬锚（在册口径见台账 G 域 testableConst 行），
 * 防无意识增长；削减钩子无需动锚（≤ 判断只拦增长，不拦收编回产品单源）。
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

/** 在锚值：守卫落地批（重评-0914-三轮 P3-14）src 全树实测 71。确属测试必需的新钩子
 *  须有意上调本值并留因，勿无意识增长（R0916-P3-14 新增 __setBookYamlLockTimeoutForTest
 *  走 A4 testableConst 工厂解构导出形态，不进本守卫计数口径，锚不动）。 */
const FOR_TEST_HOOK_CEILING = 71

const HOOK_RE = /^export (?:async )?(?:function|const) __[A-Za-z0-9_]+ForTest\b/gm

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
    let count = 0
    for (const f of collectSourceFiles(SRC_ROOT)) {
      count += (readFileSync(f, 'utf-8').match(HOOK_RE) ?? []).length
    }
    expect(
      count,
      `src 全树 __…ForTest 导出钩子实测 ${count} > 在锚 ${FOR_TEST_HOOK_CEILING}。` +
        '新增生产面测试后门须有意抬锚（在册口径见台账 G 域 testableConst 行）。',
    ).toBeLessThanOrEqual(FOR_TEST_HOOK_CEILING)
  })
})
