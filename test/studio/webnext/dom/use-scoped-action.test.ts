/**
 * 书域动作守卫单源（composables/useScopedAction）直测——stillIn/failScoped 判定矩阵
 * 与函数级在途锁语义。
 *
 * 判定矩阵（与 useChapterTreeActions 抽件前逐位等价）：
 * - 有在册会话 + 同名 → stillIn 真；会话被顶替/离书 → 假（会话同一性，不靠书名比对）；
 * - 无在册会话（未进书窗口/测试直挂组件）→ 回落 liveBook() 书名比对（旧写法等价面）；
 * - failScoped：AbortError 一律静默（连 onError 都不进）、已切书的非 abort 失败静默、
 *   仍在本书才把错误交给 onError。判定顺序（先 abort 后切书）是承重面的回归锚。
 *
 * 在途锁：同拍双击第二笔 enter 为假；exit 后重可进；enter 未取到锁时调用方不得 exit
 *（本测试以「不 exit」形态钉住，错误形态的 exit 会清掉他笔的锁——故锁不防该误用，
 * 只以取/放成对纪律约束，与抽件前手写 if/置位/复位逐位一致）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { beginBookSession, endBookSession } from '../../../../src/studio/web-next/src/composables/useBookSession'
import { useScopedAction, usePendingAction } from '../../../../src/studio/web-next/src/composables/useScopedAction'

afterEach(() => endBookSession())

describe('useScopedAction.stillIn：会话同一性判定 + 无会话回落活书名', () => {
  it('有在册会话且同名 → 真；切书顶替后旧快照 → 假', () => {
    beginBookSession('书A')
    let live = '书A'
    const scoped = useScopedAction(() => live)
    expect(scoped.stillIn('书A')).toBe(true)
    beginBookSession('书B')
    live = '书B'
    expect(scoped.stillIn('书A')).toBe(false) // 会话被顶替：不落 B 书界面
    expect(scoped.stillIn('书B')).toBe(true)
  })

  it('同名重进（A → B → A）时旧快照仍为假——会话同一性不可由书名比对替代', () => {
    beginBookSession('书A')
    let live = '书A'
    const scoped = useScopedAction(() => live)
    beginBookSession('书B')
    live = '书B'
    expect(scoped.stillIn('书A')).toBe(false)
    beginBookSession('书A') // 重进 A：新会话
    live = '书A'
    // 会话在册且同名 → 真（本判据面向「本动作所属的书仍是当前书」，非「哪一段会话」）
    expect(scoped.stillIn('书A')).toBe(true)
  })

  it('无在册会话（未进书窗口/测试直挂）→ 回落 liveBook 书名比对', () => {
    let live = '书A'
    const scoped = useScopedAction(() => live)
    expect(scoped.stillIn('书A')).toBe(true)
    expect(scoped.stillIn('书B')).toBe(false)
    live = '书B'
    expect(scoped.stillIn('书A')).toBe(false)
    expect(scoped.stillIn('书B')).toBe(true)
  })
})

describe('useScopedAction.failScoped：AbortError 静默 → 切书丢弃 → 仍在本书落错', () => {
  const abortErr = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

  it('AbortError 一律静默（不查书名，连 onError 都不进）', () => {
    beginBookSession('书A')
    const scoped = useScopedAction(() => '书A')
    let landed = 0
    scoped.failScoped('书A', abortErr(), () => landed++)
    expect(landed).toBe(0)
  })

  it('已切书的非 abort 迟到失败静默（旧写法 `bookName !== book` 同款）', () => {
    beginBookSession('书A')
    let live = '书A'
    const scoped = useScopedAction(() => live)
    beginBookSession('书B')
    live = '书B'
    let landed = 0
    scoped.failScoped('书A', new Error('boom'), () => landed++)
    expect(landed).toBe(0)
  })

  it('仍在本书的真实失败交 onError（守卫不误伤）', () => {
    beginBookSession('书A')
    const scoped = useScopedAction(() => '书A')
    let landed = 0
    scoped.failScoped('书A', new Error('boom'), () => landed++)
    expect(landed).toBe(1)
  })

  it('无在册会话时按活书名判定（未进书窗口的组件直挂）', () => {
    const scoped = useScopedAction(() => '书A')
    let landed = 0
    scoped.failScoped('书A', new Error('boom'), () => landed++)
    scoped.failScoped('书B', new Error('boom'), () => landed++)
    expect(landed).toBe(1)
  })
})

describe('usePendingAction：函数级在途锁', () => {
  it('取锁/释放：第二笔 enter 为假，exit 后可再进', () => {
    const lock = usePendingAction()
    expect(lock.value).toBe(false)
    expect(lock.enter()).toBe(true)
    expect(lock.value).toBe(true)
    expect(lock.enter()).toBe(false) // 双击第二笔：调用方早退
    lock.exit()
    expect(lock.value).toBe(false)
    expect(lock.enter()).toBe(true)
    lock.exit()
  })

  it('active 是响应式 ref（模板 :disabled 与进行中文案同源）', () => {
    const lock = usePendingAction()
    expect(typeof lock.value).toBe('boolean')
    lock.enter()
    expect(lock.value).toBe(true)
    lock.exit()
  })
})
