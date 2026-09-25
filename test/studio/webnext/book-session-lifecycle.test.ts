// @vitest-environment happy-dom
/**
 * R0916-7-P3-20（评审 P3-20）回归①：BookSession 生命周期
 * （composables/useBookSession）。
 *
 * 被测行为 = 会话三件的语义本身：进书创建（name/signal/stillIn）、离书或切书 abort
 * （旧会话信号中止、stillIn() 恒假）、以及「会话同一性而非书名比对」——后者是本次
 * 改写的实质差异：旧写法 `bookName() !== book` 在 A → B → A 的回环里会把旧请求误判
 * 为「仍在本书」，会话快照不会。
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  beginBookSession,
  bookSessionFor,
  currentBookSession,
  endBookSession,
} from '../../../src/studio/web-next/src/composables/useBookSession'

afterEach(() => endBookSession())

describe('R0916-7-P3-20: BookSession 生命周期（进书创建 / 离书 abort / stillIn 语义）', () => {
  it('未进书 → 无在册会话（current/bookSessionFor 均为 null）', () => {
    expect(currentBookSession()).toBeNull()
    expect(bookSessionFor('书A')).toBeNull()
  })

  it('进书创建：name/signal/stillIn 三件齐备，signal 未中止', () => {
    const s = beginBookSession('书A')
    expect(s).not.toBeNull()
    expect(s!.name).toBe('书A')
    expect(s!.signal).toBeInstanceOf(AbortSignal)
    expect(s!.signal.aborted).toBe(false)
    expect(s!.stillIn()).toBe(true)
    expect(currentBookSession()!.name).toBe('书A')
    expect(bookSessionFor('书A')!.stillIn()).toBe(true)
  })

  it('书名不符时取不到会话（动作入口按书名归属，非同名即「已不在册」）', () => {
    beginBookSession('书A')
    expect(bookSessionFor('书B')).toBeNull()
  })

  it('离书：signal 中止（在途请求随之 AbortError）、stillIn() 恒假、在册位清空', () => {
    const s = beginBookSession('书A')!
    expect(s.signal.aborted).toBe(false)
    endBookSession()
    expect(s.signal.aborted).toBe(true)
    expect(s.stillIn()).toBe(false)
    expect(currentBookSession()).toBeNull()
    expect(bookSessionFor('书A')).toBeNull()
  })

  it('切书顶替：begin(书B) 即 abort 书A 会话——旧快照 stillIn() 假（迟到结果不得落新书）', () => {
    const a = beginBookSession('书A')!
    const b = beginBookSession('书B')!
    expect(a.signal.aborted).toBe(true)
    expect(a.stillIn()).toBe(false)
    expect(b.signal.aborted).toBe(false)
    expect(b.stillIn()).toBe(true)
    expect(currentBookSession()!.name).toBe('书B')
  })

  it('同名重进也是新会话：A → B → A 后，第一段 A 的快照仍为假（会话同一性，不靠书名比对）', () => {
    const firstA = beginBookSession('书A')!
    beginBookSession('书B')
    const secondA = beginBookSession('书A')!
    expect(secondA).not.toBe(firstA)
    expect(firstA.stillIn()).toBe(false) // 旧写法按书名比对会在此误判为「仍在本书」
    expect(firstA.signal.aborted).toBe(true)
    expect(secondA.stillIn()).toBe(true)
    expect(secondA.signal.aborted).toBe(false)
  })

  it('空书名 = 离书（脏路由/返回书架路径的统一调用形态）', () => {
    const a = beginBookSession('书A')!
    expect(beginBookSession('')).toBeNull()
    expect(a.signal.aborted).toBe(true)
    expect(currentBookSession()).toBeNull()
  })

  it('重复离书幂等（无在册会话时 endBookSession 不抛）', () => {
    endBookSession()
    endBookSession()
    expect(currentBookSession()).toBeNull()
  })
})
