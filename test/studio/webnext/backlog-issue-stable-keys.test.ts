/**
 * R59 清偿批（R57-F-2）回归：三审意见 / 机检命中列表的 v-for 稳定键。
 *
 * ReviewPanel blockers/warnings 原用位置索引（'b'+i / 'w'+i）；CheckPanel 红/黄项
 * 原用 it.checkId 作键——checkId 是检查器级 id（同一检查器多条命中同 id，如
 * banned-word 多处命中），多条命中时必撞重复键。修法：键构造抽纯函数单源
 * （shared/issue-keys.ts），以内容字段最小组合作稳定键 + 同内容出现序 #n 消歧。
 */
import { describe, it, expect } from 'vitest'
import {
  reviewIssueKeyBase,
  checkItemKeyBase,
  contentStableKeys,
} from '../../../src/studio/web-next/src/shared/issue-keys'
import type { ReviewIssueFE } from '../../../src/studio/web-next/src/api/review'
import type { CheckItem } from '../../../src/studio/web-next/src/api/check'

function reviewIssue(partial: Partial<ReviewIssueFE>): ReviewIssueFE {
  return {
    lens: 'reader',
    severity: 'S1',
    category: 'logic',
    location: '第3章 §2',
    evidence: ['证据一'],
    issue: '时间线断裂',
    fix: '补过渡句',
    ...partial,
  }
}

describe('R59 清偿批（R57-F-2）: contentStableKeys', () => {
  it('同基串第 n 次出现追加 #n 消歧，首次出现不加后缀', () => {
    expect(contentStableKeys(['a', 'b', 'a', 'a', 'b'])).toEqual(['a', 'b', 'a#2', 'a#3', 'b#2'])
  })

  it('键与列表位置无关：distinct 条目重排后各自键不变（稳定键语义核心）', () => {
    const bases = ['k1', 'k2', 'k3']
    expect(contentStableKeys(bases)).toEqual(bases)
    expect(contentStableKeys([...bases].reverse())).toEqual([...bases].reverse())
  })

  it('完全同内容的条目键仍互异（不产生 Vue 重复键）', () => {
    const keys = contentStableKeys(['same', 'same'])
    expect(new Set(keys).size).toBe(2)
  })
})

describe('R59 清偿批（R57-F-2）: reviewIssueKeyBase（ReviewPanel 意见键）', () => {
  it('同内容条目 → 同基串；任一内容字段不同 → 异基串', () => {
    const a = reviewIssue({})
    expect(reviewIssueKeyBase(a)).toBe(reviewIssueKeyBase(reviewIssue({})))
    expect(reviewIssueKeyBase(a)).not.toBe(reviewIssueKeyBase(reviewIssue({ issue: '另一问题' })))
    expect(reviewIssueKeyBase(a)).not.toBe(reviewIssueKeyBase(reviewIssue({ lens: 'editor' })))
    expect(reviewIssueKeyBase(a)).not.toBe(reviewIssueKeyBase(reviewIssue({ location: '第4章' })))
  })

  it('evidence / fix 纳入键：同 lens/location/issue 但建议不同 → 异键', () => {
    const a = reviewIssue({})
    expect(reviewIssueKeyBase(a)).not.toBe(reviewIssueKeyBase(reviewIssue({ fix: '改写结尾' })))
    expect(reviewIssueKeyBase(a)).not.toBe(reviewIssueKeyBase(reviewIssue({ evidence: ['证据二'] })))
  })
})

describe('R59 清偿批（R57-F-2）: checkItemKeyBase（CheckPanel 红/黄项键）', () => {
  it('核心回归：同 checkId（检查器级）不同命中（message）→ 异键，多条命中不再撞重复键', () => {
    const hit1: CheckItem = { checkId: 'banned-word', level: 'red', message: '第2段「然后」连用' }
    const hit2: CheckItem = { checkId: 'banned-word', level: 'red', message: '第5段「然后」连用' }
    expect(checkItemKeyBase(hit1)).not.toBe(checkItemKeyBase(hit2))
    // 同 checkId + 同 message（字面重复命中）→ 同基串，由 contentStableKeys #n 消歧
    expect(checkItemKeyBase(hit1)).toBe(
      checkItemKeyBase({ checkId: 'banned-word', level: 'red', message: '第2段「然后」连用' }),
    )
  })

  it('leadId / chapter 纳入键：可选字段不同 → 异键', () => {
    const a: CheckItem = { checkId: 'repeat', level: 'yellow', message: '复读' }
    expect(checkItemKeyBase(a)).not.toBe(
      checkItemKeyBase({ checkId: 'repeat', level: 'yellow', message: '复读', chapter: 3 }),
    )
    expect(checkItemKeyBase(a)).not.toBe(
      checkItemKeyBase({ checkId: 'repeat', level: 'yellow', message: '复读', leadId: 'L1' }),
    )
  })
})
