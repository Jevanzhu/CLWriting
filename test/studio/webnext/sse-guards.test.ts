/**
 * R73-68（批 F-1）：SSE 事件 type guard 全分支直测（此前零直测）。
 *
 * sse-guards.ts 是 stores 的 SSE 事件运行时校验唯一收口（workbench.ts / chat.ts 消费），
 * 守卫放宽或收窄都会静默改变前端对后端事件的容错面（后端结构变化 → 前端静默失败
 * 正是本模块的立项动机）。本文件对每个导出逐个锚定「接受集 + 拒绝集」：拒绝集用例
 * 即放宽即红——未来把非法 phase/outcome/字段类型放行时，对应用例首红。
 *
 * 现状锚（非建议）：isHealResultEvent 对 reds/yellows 只校验 Array.isArray、不校验
 * 元素类型（元素收窄是编译期语义）；isSseEvent 对 type: '' 放行（空串也是 string）。
 * 用例按现行为锚定，行为变更须显式改用例而非悄悄漂移。
 */
import { describe, it, expect } from 'vitest'
import {
  str,
  strArr,
  isSseEvent,
  isHealPhaseEvent,
  isHealResultEvent,
} from '../../../src/studio/web-next/src/stores/sse-guards'

describe('R73-68：str 字段安全提取', () => {
  it('字符串原样返回（含空串）', () => {
    expect(str('hello')).toBe('hello')
    expect(str('')).toBe('')
  })

  it('非字符串一律 undefined（拒绝数字/布尔/null/undefined/对象/数组误用）', () => {
    expect(str(1)).toBeUndefined()
    expect(str(0)).toBeUndefined()
    expect(str(true)).toBeUndefined()
    expect(str(null)).toBeUndefined()
    expect(str(undefined)).toBeUndefined()
    expect(str({})).toBeUndefined()
    expect(str(['a'])).toBeUndefined()
  })
})

describe('R73-68：strArr 字符串数组提取', () => {
  it('字符串数组原样返回；空数组也返回（不是 undefined）', () => {
    expect(strArr(['a', 'b'])).toEqual(['a', 'b'])
    expect(strArr([])).toEqual([])
  })

  it('过滤数组内的非字符串元素（混合数组只留字符串）', () => {
    expect(strArr(['a', 1, 'b', null, true, ['c']])).toEqual(['a', 'b'])
  })

  it('非数组一律 undefined', () => {
    expect(strArr('abc')).toBeUndefined()
    expect(strArr(123)).toBeUndefined()
    expect(strArr(null)).toBeUndefined()
    expect(strArr(undefined)).toBeUndefined()
    expect(strArr({ length: 0 })).toBeUndefined()
  })
})

describe('R73-68：isSseEvent 基础守卫', () => {
  it('对象 + type 字符串 → true（多余字段容忍，SSE 载荷可携带任意附加字段）', () => {
    expect(isSseEvent({ type: 'self_heal_phase' })).toBe(true)
    expect(isSseEvent({ type: 'anything', payload: { a: 1 } })).toBe(true)
    expect(isSseEvent({ type: '' })).toBe(true) // 现状锚：空串也是 string
  })

  it('非对象或 type 缺失/非字符串 → false（放宽即红）', () => {
    expect(isSseEvent(null)).toBe(false)
    expect(isSseEvent(undefined)).toBe(false)
    expect(isSseEvent('self_heal_phase')).toBe(false)
    expect(isSseEvent(42)).toBe(false)
    expect(isSseEvent([])).toBe(false)
    expect(isSseEvent({})).toBe(false)
    expect(isSseEvent({ type: 123 })).toBe(false)
    expect(isSseEvent({ type: null })).toBe(false)
  })
})

describe('R73-68：isHealPhaseEvent 阶段白名单守卫', () => {
  it('五合法 phase 各自放行并收窄 type（drafting/checking/rewriting/chapter_start/chapter_done）', () => {
    for (const phase of ['drafting', 'checking', 'rewriting', 'chapter_start', 'chapter_done'] as const) {
      expect(isHealPhaseEvent({ type: 'self_heal_phase', phase })).toBe(true)
    }
  })

  it('type 不符 → false（其他 SSE 事件不得误入 heal 分支）', () => {
    expect(isHealPhaseEvent({ type: 'self_heal_result', phase: 'drafting' })).toBe(false)
    expect(isHealPhaseEvent({ type: 'token', phase: 'drafting' })).toBe(false)
  })

  it('type 符但 phase 非法 → false（放宽即红：新增 phase 须同步白名单与本用例）', () => {
    expect(isHealPhaseEvent({ type: 'self_heal_phase', phase: 'draft' })).toBe(false) // 截断词
    expect(isHealPhaseEvent({ type: 'self_heal_phase', phase: 'Drafting' })).toBe(false) // 大小写
    expect(isHealPhaseEvent({ type: 'self_heal_phase', phase: 123 })).toBe(false)
    expect(isHealPhaseEvent({ type: 'self_heal_phase' })).toBe(false) // phase 缺失
    expect(isHealPhaseEvent({ type: 'self_heal_phase', phase: null })).toBe(false)
  })
})

describe('R73-68：isHealResultEvent 终局守卫', () => {
  it('四合法 outcome 各自放行（pass/escalate/aborted/failed）', () => {
    for (const outcome of ['pass', 'escalate', 'aborted', 'failed'] as const) {
      expect(isHealResultEvent({ type: 'self_heal_result', outcome })).toBe(true)
    }
  })

  it('可选字段全部缺省 → true（最小合法载荷）', () => {
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass' })).toBe(true)
  })

  it('可选字段合法形态 → true', () => {
    expect(
      isHealResultEvent({
        type: 'self_heal_result',
        outcome: 'escalate',
        reds: ['d1', 'd2'],
        yellows: [],
        docId: 'doc-1',
        path: '写作/正文/0001.md',
        error: 'boom',
      }),
    ).toBe(true)
  })

  it('reds/yellows 非数组 → false（放宽即红）', () => {
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', reds: 'd1' })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', yellows: 3 })).toBe(false)
    // 现状锚：只校验容器不校验元素——含非字符串元素的数组仍放行（收窄属行为变更，须改本用例）
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', reds: [1] })).toBe(true)
  })

  it('docId/path/error 非字符串 → false；字符串 → true（放宽即红）', () => {
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', docId: 1 })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', path: {} })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', error: true })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'pass', docId: '' })).toBe(true)
  })

  it('type 不符或 outcome 非法/缺失 → false', () => {
    expect(isHealResultEvent({ type: 'self_heal_phase', outcome: 'pass' })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: 'ok' })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result' })).toBe(false)
    expect(isHealResultEvent({ type: 'self_heal_result', outcome: null })).toBe(false)
  })
})
