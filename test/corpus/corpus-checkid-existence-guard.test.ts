/**
 * R51-J-4（五十一轮）：语料回归门 checkId 存在性守卫。
 *
 * 语料回归门（test/check/corpus.test.ts）按文件名 <checkId>.json 匹配检查项：
 * checkId 在引擎侧死亡（改名/移除）后——
 *   - expect:"silent" 的用例「不得命中」恒真（检查器永远产不出该 checkId）；
 *   - 仅 silent 的语料文件整文件恒真绿，golden-master 门对该检查静默失效。
 * fire 用例虽会红，但 mixed 文件红声会掩盖「该 checkId 已不存在」的真实病因
 * （报「真命中丢失」而非「checkId 不存在」）。本守卫在装载层直接断言：语料
 * 引用的 checkId 都在引擎已知集合内，checkId 死亡当天即红且人话指路。
 *
 * 引擎已知集合 = 已知清单（正本，2026-09-06 收集自 src/check/ 各检查的 checkId
 * 字面量全集：count/growth/leads/manifest-check/runner）。检查器增删改名时
 * 须同步维护本清单——清单本身也是「引擎 checkId 面」的契约快照。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 语料引用面：文件名即 checkId（与语料门装载口径一致：.json 后缀、`_` 前缀豁免） */
const CORPUS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'checks')

/** 引擎已知 checkId 全集（src/check/*.ts 字面量收集；增删检查器须同步维护） */
const KNOWN_CHECK_IDS: readonly string[] = [
  // runner.ts（编排层合成项）
  'banned-entry-unparsed',
  'piece-list-unreadable',
  'piece-list-outline-missing',
  // count.ts（通用章检）
  'banned-word',
  'word-count',
  'repeat',
  'sentence-length',
  'simile-density',
  'body-parts',
  'imagery-overuse',
  'new-name',
  'opening-env',
  'info-leak-candidate',
  'section-count',
  'section-count-heading-missing',
  'style-adj-stack',
  'style-dialogue-tag',
  'style-dialogue-tag-ratio',
  'style-parallel-streak',
  'style-sentence-overlong',
  'style-summary-ending',
  // leads.ts（账本机检）
  'lead-chapter-disorder',
  'lead-chapter-future',
  'lead-declared-not-done',
  'lead-done-not-declared',
  'lead-evidence-miss',
  'lead-evidence-unverifiable',
  'lead-outline-unreadable',
  'lead-status-drift',
  'lead-status-open',
  'lead-updates-unreadable',
  'lead-verb-invalid',
  // growth.ts（成长线机检）
  'growth-current-realm-missing',
  'growth-evidence-no-realm',
  'growth-realm-miss',
  'growth-realm-sequence-missing',
  'growth-regress',
  'growth-span-exceed',
  'growth-verb-invalid',
  // manifest-check.ts（反转线索表机检）
  'manifest-no-reversal',
  'manifest-payoff-open',
  'manifest-setup-short',
  'emotion-curve-no-reversal',
  'emotion-curve-peak-low',
  'emotion-curve-short',
  'emotion-curve-strength',
  // 短篇/章纲族
  'piece-word-long',
  'piece-word-short',
  'fm-chapter-mismatch',
  'fm-enum',
  'fm-missing',
  // 健康报告级（cache/rebuild 经 run.ts 消费面）
  'book-config-degraded',
  'roster-unreadable',
]

describe('R51-J-4：语料回归门 checkId 存在性守卫', () => {
  it('语料目录在库（守卫自身的哨兵：目录缺失 = 本守卫空转）', () => {
    expect(existsSync(CORPUS_DIR), `语料目录缺失：${CORPUS_DIR}——本守卫与 golden-master 门同时空转`).toBe(true)
  })

  it('语料引用的 checkId 都在引擎已知集合内（checkId 死亡不再恒真绿）', () => {
    const referenced: string[] = []
    for (const f of readdirSync(CORPUS_DIR)) {
      if (!f.endsWith('.json') || f.startsWith('_')) continue
      const checkId = f.replace(/\.json$/, '')
      referenced.push(checkId)
      expect(
        KNOWN_CHECK_IDS.includes(checkId),
        `语料文件「${f}」引用的 checkId='${checkId}' 不在引擎已知集合中——` +
          `该检查已被改名/移除，语料门对它恒真绿（silent 用例永真、golden-master 失效）。` +
          `请改：①以新 checkId 重命名语料文件并复核每条 expect 判定仍成立；②或删除该语料文件并在提交说明登记取舍`,
      ).toBe(true)
    }
    // 语料非空哨兵：至少 1 个 checkId 被引用（空目录 = 门与守卫双双空转，须显式知悉）
    expect(referenced.length, '语料目录为空：golden-master 门无覆盖面，请先 corpus:harvest 自举或确认清空是有意为之').toBeGreaterThan(0)
  })

  it('已知清单自身无重复项（清单是契约快照，重复项即维护失误）', () => {
    expect(new Set(KNOWN_CHECK_IDS).size).toBe(KNOWN_CHECK_IDS.length)
  })
})
