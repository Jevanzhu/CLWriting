/**
 * eslint 抑制表「只减不增」守护：`eslint-suppressions.json` 的抑制量级冻结在
 * 基线档位以下——任何位置新增抑制、或既有位置把计数调高，本档即红。
 *
 * 由来：本仓对存量违规采用计数式抑制（`eslint.config.js` 的 suppressions 机制），
 * 好处是 lint 门对新增违规仍 fail-closed，代价是抑制表本身会**缓慢膨胀**——
 * 修一处、补一处的形态在计数上互相抵消，lint 门看不见。CI 的 `lint:prune` 步只
 * 校验「失效条目已删」（prune 后 diff 为空），对「新增条目」无判据。本档补这一半。
 *
 * 已知盲区（有意不覆盖，勿当漏判）：同一 (文件, 规则) 上「修掉一处再新增一处」
 * 计数不变即通过。要拦该形态需逐函数级 AST 比对，成本与本表收益不成比例；
 * 净下降靠「触碰即降」——改动某文件时顺带消解其抑制项，并把基线档位同步下调。
 *
 * 维护纪律：**基线只许下调，不许上调**。确需上调（例如新接入一批文件的历史违规）
 * 时，须在提交说明里写明理由，属显式决策而非顺手放过。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** 抑制表条目计数的两种历史写法（裸数字 / `{ count }`），归一为数字。 */
function countOf(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value !== null && 'count' in value) {
    const c = (value as { count?: unknown }).count
    return typeof c === 'number' ? c : 0
  }
  return 0
}

interface SuppressionTable {
  /** (文件, 规则) → 抑制计数 */
  byFileRule: Map<string, number>
  /** 规则 → 抑制计数（跨文件合计） */
  byRule: Map<string, number>
  total: number
  fileCount: number
}

function readSuppressionTable(): SuppressionTable {
  const raw = JSON.parse(readFileSync(new URL('eslint-suppressions.json', new URL('../../', import.meta.url)), 'utf-8')) as Record<
    string,
    Record<string, unknown>
  >
  const byFileRule = new Map<string, number>()
  const byRule = new Map<string, number>()
  let total = 0
  for (const [file, rules] of Object.entries(raw)) {
    for (const [rule, value] of Object.entries(rules)) {
      const n = countOf(value)
      byFileRule.set(`${file}\u0000${rule}`, n)
      byRule.set(rule, (byRule.get(rule) ?? 0) + n)
      total += n
    }
  }
  return { byFileRule, byRule, total, fileCount: Object.keys(raw).length }
}

/**
 * 基线档位（= 2026-10-11 三审修复批收口时的实测值）。
 * **只许下调**：消解了抑制项就把对应数字改小；不得为了放行新增而上调。
 */
const BASELINE_TOTAL = 348
const BASELINE_RULE_CEILING: Readonly<Record<string, number>> = {
  '@typescript-eslint/no-base-to-string': 83,
  '@typescript-eslint/no-unnecessary-type-assertion': 76,
  complexity: 52,
  '@typescript-eslint/no-unsafe-assignment': 29,
  '@typescript-eslint/require-await': 16,
  'max-depth': 13,
  '@typescript-eslint/no-unsafe-member-access': 11,
  'max-lines-per-function': 11,
  '@typescript-eslint/no-misused-promises': 10,
  '@typescript-eslint/no-unsafe-argument': 8,
  '@typescript-eslint/prefer-promise-reject-errors': 8,
  '@typescript-eslint/return-await': 7,
  '@typescript-eslint/no-unsafe-call': 6,
  '@typescript-eslint/only-throw-error': 6,
  '@typescript-eslint/await-thenable': 3,
  '@typescript-eslint/no-unsafe-return': 3,
  '@typescript-eslint/restrict-template-expressions': 2,
  '@typescript-eslint/unbound-method': 2,
  'vue/no-mutating-props': 2,
}

describe('eslint 抑制表只减不增守护', () => {
  it('抑制总量不超过基线（新增抑制即红）', () => {
    const { total } = readSuppressionTable()
    expect(
      total,
      `抑制表总量 ${total} 已超基线 ${BASELINE_TOTAL}——新增的抑制需就地消解（改代码）` +
        '而不是登记；确需上调基线须在提交说明写明理由。',
    ).toBeLessThanOrEqual(BASELINE_TOTAL)
  })

  it('逐规则抑制量不超过基线（某规则加量即红）', () => {
    const { byRule } = readSuppressionTable()
    const over: string[] = []
    for (const [rule, base] of Object.entries(BASELINE_RULE_CEILING)) {
      const now = byRule.get(rule) ?? 0
      if (now > base) over.push(`${rule}: ${now} > 基线 ${base}`)
    }
    expect(over, '以下规则抑制量超基线：\n' + over.join('\n')).toEqual([])
  })

  it('不出现基线外的新规则（换一种规则登记同样算新增）', () => {
    const { byRule } = readSuppressionTable()
    const unknown = [...byRule.keys()].filter((r) => !(r in BASELINE_RULE_CEILING))
    expect(
      unknown,
      '出现基线外的新抑制规则：\n' +
        unknown.join('\n') +
        '\n新规则要么就地修掉，要么作为显式决策补进 BASELINE_RULE_CEILING。',
    ).toEqual([])
  })

  it('基线表自身无冗余项（已清零的规则须从基线删除，防基线虚高）', () => {
    const { byRule } = readSuppressionTable()
    const stale = Object.keys(BASELINE_RULE_CEILING).filter((r) => (byRule.get(r) ?? 0) === 0)
    expect(stale, '以下规则抑制已清零但仍留在基线表（请从 BASELINE_RULE_CEILING 删除）：' + stale.join(', ')).toEqual([])
  })

  it('抑制表可读且形态合法（解析失败/结构漂移即红，防守护静默空转）', () => {
    const t = readSuppressionTable()
    expect(t.fileCount, '抑制表为空——守护失去对象，请确认文件路径未被移动').toBeGreaterThan(0)
    expect(root.length).toBeGreaterThan(0)
  })
})
