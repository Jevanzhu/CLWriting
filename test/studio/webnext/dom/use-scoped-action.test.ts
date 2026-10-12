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
 *
 * useBookActionRunner（多 await 动作的执行器）：把上述三件套 + 在途锁收成单点后，
 * 动作侧的关键不变量在此直测——体抛错（含非 Error 值）不漏放锁、不冒泡给调用方；
 * step 落定后切书即哨兵中断（体尾语句不执行、失败面不进）；取锁失败则连入口清错误条
 * 都不执行（与逐点手写时的次序一致）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { beginBookSession, endBookSession } from '../../../../src/studio/web-next/src/composables/useBookSession'
import {
  useScopedAction,
  usePendingAction,
  useBookActionRunner,
} from '../../../../src/studio/web-next/src/composables/useScopedAction'

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

describe('useBookActionRunner：多 await 动作的执行器（复检/尾款/锁 收成单点）', () => {
  it('体抛错 → onError 收到原错误、run 自身恒不拒绝、锁已释放', async () => {
    beginBookSession('书A')
    const pending = usePendingAction()
    const seen: unknown[] = []
    const boom = new Error('动作炸了')
    await expect(
      useBookActionRunner(() => '书A').run({
        pending,
        body: async () => {
          throw boom
        },
        onError: (e) => seen.push(e),
      }),
    ).resolves.toBeUndefined() // 调用方无需自备 catch（尾款归执行器）
    expect(seen).toEqual([boom])
    expect(pending.value).toBe(false) // 放锁在 finally：体抛错也不漏
  })

  it('体抛非 Error 值 → 同样进 onError（哨兵之外的抛错一律按失败处理）且锁必释放', async () => {
    beginBookSession('书A')
    const pending = usePendingAction()
    const seen: unknown[] = []
    // 变量声明为 unknown：真实上游（fetch 包装/SDK）确实会抛非 Error 值，
    // 执行器不得用 instanceof Error 判失败（那条判定会把这类失败静默吞掉）
    const weird: unknown = '字符串错误'
    await useBookActionRunner(() => '书A').run({
      pending,
      body: async () => {
        throw weird
      },
      onError: (e) => seen.push(e),
    })
    expect(seen).toEqual([weird])
    expect(pending.value).toBe(false)
  })

  it('step 落定后已切书 → 体尾语句不执行、onError 不进（迟到结果静默吸收）', async () => {
    beginBookSession('书A')
    const liveBook = { name: '书A' }
    const pending = usePendingAction()
    const tail: string[] = []
    const seen: unknown[] = []
    await useBookActionRunner(() => liveBook.name).run({
      pending,
      body: async ({ book, step }) => {
        expect(book).toBe('书A') // 入口捕获的书名
        beginBookSession('书B') // 请求在途期间切书
        liveBook.name = '书B'
        await step(async () => '迟到的成功结果')
        tail.push('体尾副作用') // 哨兵中断后不得执行（提示/落态/开 tab 都在体尾）
      },
      onError: (e) => seen.push(e),
    })
    expect(tail).toEqual([])
    expect(seen).toEqual([]) // 切书后的失败不进错误面
    expect(pending.value).toBe(false)
  })

  it('取锁失败 → 体与入口清错误条都不执行，且不释放他笔的锁', async () => {
    const pending = usePendingAction()
    pending.enter() // 模拟他笔在途
    const calls: string[] = []
    await useBookActionRunner(() => '书A').run({
      pending,
      clearError: () => calls.push('clearError'),
      body: async () => {
        calls.push('body')
      },
      onError: () => calls.push('onError'),
    })
    expect(calls).toEqual([])
    expect(pending.value).toBe(true) // 第二笔不得 exit 掉他笔的锁
    pending.exit()
  })

  it('入口清错误条先于体（次序与逐点手写一致）', async () => {
    const calls: string[] = []
    await useBookActionRunner(() => '书A').run({
      clearError: () => calls.push('clearError'),
      body: async ({ step }) => {
        calls.push('body')
        await step(async () => undefined)
      },
      onError: () => calls.push('onError'),
    })
    expect(calls).toEqual(['clearError', 'body'])
  })

  it('两个 step 连用：前一步落定即复检，切书后后续请求不再发出', async () => {
    beginBookSession('书A')
    const liveBook = { name: '书A' }
    const sent: string[] = []
    await useBookActionRunner(() => liveBook.name).run({
      body: async ({ step }) => {
        sent.push(await step(async () => '第一笔'))
        beginBookSession('书B') // 第一笔落定后切书
        liveBook.name = '书B'
        sent.push(await step(async () => '第二笔'))
      },
      onError: () => {},
    })
    expect(sent).toEqual(['第一笔']) // 第二笔（含其副作用）不执行
  })
})
