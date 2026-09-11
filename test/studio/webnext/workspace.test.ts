// @vitest-environment happy-dom
/**
 * workspace store 测试：单文档打开/切换（旧文档 dirty 自动保存）
 * + localStorage 持久化恢复 + validate 失效清空 + 新建信号。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
// flush：让 setBook 的异步 loadBookPrefs + debounce 500ms persist 落定
const flush = () => vi.advanceTimersByTimeAsync(600)
import { createPinia, setActivePinia } from 'pinia'

// doc store 用 hoisted mock：不同用例控制 get(dirty)/save(成败)/waitInflightSave(在途落定)
const { docGet, docSave, docWait, toastSpy } = vi.hoisted(() => ({
  docGet: vi.fn(),
  docSave: vi.fn(),
  // R0911b-P2②（2026-09-11 全量重评 GLM-5.3 修复批）：openTab 存旧文档先等在途落定——
  // 观察口默认即刻 resolve（无在途），个别用例以受控 promise 模拟在途窗口
  docWait: vi.fn(),
  // 清偿-切换autosave失败可见化（2026-09-09 残留清偿批）：openTab 失败 toast 观察口
  toastSpy: vi.fn(),
}))
vi.mock('../../../src/studio/web-next/src/stores/doc', () => ({
  useDocStore: () => ({ get: docGet, save: docSave, waitInflightSave: docWait }),
}))
vi.mock('../../../src/studio/web-next/src/stores/ui', () => ({
  useUiStore: () => ({ toast: toastSpy }),
}))

// prefs API mock：内存 Map 模拟书级 prefs 持久化（配置重构后 localStorage → API）
const { bookPrefs } = vi.hoisted(() => ({
  bookPrefs: new Map<string, Record<string, unknown>>(),
}))
vi.mock('../../../src/studio/web-next/src/api/prefs', () => ({
  getBookPrefs: vi.fn(async (name: string) => ({ ...(bookPrefs.get(name) ?? {}) })),
  putBookPrefs: vi.fn(async (name: string, data: Record<string, unknown>) => {
    bookPrefs.set(name, { ...data })
  }),
  usePrefsStore: () => ({
    bookPageWidth: null,
    bookAutosaveInterval: null,
    apply: () => {},
  }),
}))

import { useWorkspaceStore } from '../../../src/studio/web-next/src/stores/workspace'
import { getBookPrefs, putBookPrefs } from '../../../src/studio/web-next/src/api/prefs'

const BOOK = 'test-book'

// happy-dom localStorage 在 vitest 集成下缺 clear()，提供一个完整 Map-backed 替身
function createLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
}
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  vi.useFakeTimers()
  localStorageMock.clear()
  bookPrefs.clear()
  setActivePinia(createPinia())
  docGet.mockReturnValue(undefined)
  docSave.mockReset()
  // 清偿批：默认 save 成功——真实 doc.save 吞错以 Promise<boolean> 落定（不 reject），
  // openTab 现挂 .then 消费返回值，mock 须回 Promise（undefined 会 .then 崩）
  docSave.mockResolvedValue(true)
  // R0911b-P2②：waitInflightSave 默认即刻落定（无在途），个别用例覆写为受控 promise
  docWait.mockReset()
  docWait.mockResolvedValue(undefined)
  toastSpy.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

// R0911b-P2②：openTab 的存旧文档链改为异步（waitInflightSave 先行）——多拍 microtask
// 冲刷等整链落定（mock 均即刻 resolve，10 拍足以走完「等在途→复查→补存→判失败」全链）
const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** 受控在途窗口（模拟旧文档 saving 中：waitInflightSave 挂起直至测试放行落定） */
function deferredWait(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('workspace · 单文档打开切换', () => {
  it('openTab → activeDocId + 回编辑器视图', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.setActiveView('workbench')
    ws.openTab('d1')
    expect(ws.activeDocId).toBe('d1')
    expect(ws.activeView).toBe('editor')
  })

  it('openTab 切换 → 覆盖 activeDocId（不累积）', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.openTab('d2')
    expect(ws.activeDocId).toBe('d2')
  })

  // R0911b-P2②：存旧文档链异步化（waitInflightSave 先行）——切换本身仍同步完成
  it('切换时旧文档 dirty → 静默自动保存', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.openTab('d2')
    expect(ws.activeDocId).toBe('d2') // 切换不被存档链阻断（同步完成）
    await drain()
    expect(docSave).toHaveBeenCalledWith('d1', 'autosave')
  })

  it('旧文档非 dirty → 不保存', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: false })
    ws.openTab('d2')
    expect(docSave).not.toHaveBeenCalled()
  })

  it('重开同一文档 → 不触发保存', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.openTab('d1')
    expect(docSave).not.toHaveBeenCalled()
    expect(ws.activeDocId).toBe('d1')
  })
})

// 清偿-切换autosave失败可见化（2026-09-09 残留清偿批）：openTab fire-and-forget 存旧文档
// 失败零 UI 面 → 补 toast warning（迟到态不抛错不打断切换；在途切书后不落新书界面）
describe('workspace · 清偿批：切换 autosave 失败可见化', () => {
  it('旧文档 dirty 且 save 失败 → toast warning，切换本身不被打断', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    docSave.mockResolvedValueOnce(false)
    ws.openTab('d2')
    expect(ws.activeDocId).toBe('d2') // 切换先行完成
    await drain() // 迟到失败态（异步链落定）
    expect(toastSpy).toHaveBeenCalledWith('切换文档时自动保存失败，未保存内容仍保留', 'warning')
  })

  it('save 成功 → 不 toast', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    ws.openTab('d2')
    await drain()
    expect(docSave).toHaveBeenCalledWith('d1', 'autosave')
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('save 失败但在途切书 → 迟到失败提示不落新书界面（入口书名快照守卫）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('A书')
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true })
    let resolveSave!: (v: boolean) => void
    docSave.mockReturnValueOnce(new Promise<boolean>((r) => (resolveSave = r)))
    ws.openTab('d2')
    ws.setBook('B书') // save 在途切书
    resolveSave(false)
    await drain()
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

// R0911b-P2②（2026-09-11 全量重评 GLM-5.3 修复批）：openTab 存旧文档对齐 doDelete
//（R55-F-6）同族「先落定在途再判」——saving 在途窗口不再误报「自动保存失败」假警报
//（修复前 F8 契约下 saving 中 autosave 直接返 false，dirty 未清即被当成失败弹 toast）
describe('workspace · R0911b-P2②：切档在途保存不假警报', () => {
  it('saving 在途 → 等落定期不补存；落定已转 clean → 静默收尾（零假警报）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true, saving: true })
    const d = deferredWait()
    docWait.mockReturnValueOnce(d.promise)
    docSave.mockResolvedValue(false) // 契约：saving 中 autosave 直接返 false——不得被消费成警报
    ws.openTab('d2')
    expect(docSave).not.toHaveBeenCalled() // 在途未落定不补存（修复前此处已误报路径的入口）
    docGet.mockReturnValue({ dirty: false, saving: false }) // 在途保存落定且已代存成功
    d.resolve()
    await drain()
    expect(docSave).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('落定复查仍 dirty → 补存一次（autosave），成功不提示', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true, saving: true })
    const d = deferredWait()
    docWait.mockReturnValueOnce(d.promise)
    ws.openTab('d2')
    docGet.mockReturnValue({ dirty: true, saving: false }) // 落定复查：仍 dirty（在途没存上）
    docSave.mockResolvedValueOnce(true)
    d.resolve()
    await drain()
    expect(docSave).toHaveBeenCalledWith('d1', 'autosave')
    expect(toastSpy).not.toHaveBeenCalled()
  })

  it('真失败（无在途、save 返 false 且仍 dirty）→ 仍 toast 可见化', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true, saving: false })
    docSave.mockResolvedValueOnce(false)
    ws.openTab('d2')
    await drain()
    expect(docSave).toHaveBeenCalledWith('d1', 'autosave')
    expect(toastSpy).toHaveBeenCalledWith('切换文档时自动保存失败，未保存内容仍保留', 'warning')
  })

  it('落定时又有新在途接手（saving 仍 true）→ 不补存不误报（结局交其自担）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    docGet.mockReturnValue({ dirty: true, saving: true })
    const d = deferredWait()
    docWait.mockReturnValueOnce(d.promise)
    ws.openTab('d2')
    docGet.mockReturnValue({ dirty: true, saving: true }) // 落定复查：新在途在跑
    d.resolve()
    await drain()
    expect(docSave).not.toHaveBeenCalled()
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

describe('workspace · 持久化与恢复', () => {
  it('openTab 后新实例 setBook 同书 → 恢复 activeDocId', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    ws.openTab('d1')
    await flush() // 等 debounce persist 写回 prefs
    // 模拟刷新：新 pinia 实例
    setActivePinia(createPinia())
    const ws2 = useWorkspaceStore()
    ws2.setBook(BOOK)
    await flush()
    expect(ws2.activeDocId).toBe('d1')
  })

  it('setBook 无记录 → 空', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('其他书')
    await flush()
    expect(ws.activeDocId).toBeNull()
  })

  it('localStorage 损坏 → 降级空', async () => {
    localStorage.setItem('clw2.workspace.bad', '{not json')
    const ws = useWorkspaceStore()
    ws.setBook('bad')
    await flush()
    expect(ws.activeDocId).toBeNull()
  })
})

describe('workspace · validate 失效清空', () => {
  it('activeDocId 失效 → 清空', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d3')
    ws.validate(new Set(['d1', 'd2']))
    expect(ws.activeDocId).toBeNull()
  })

  it('activeDocId 有效 → 不变', () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    ws.openTab('d1')
    ws.validate(new Set(['d1', 'd2']))
    expect(ws.activeDocId).toBe('d1')
  })
})

describe('workspace · 新建信号', () => {
  it('triggerCreate 默认正文 → kind=chapter + tick 递增', () => {
    const ws = useWorkspaceStore()
    const before = ws.createTick
    ws.triggerCreate()
    expect(ws.createKind).toBe('chapter')
    expect(ws.createTick).toBe(before + 1)
  })

  it('triggerCreate 指定类型 → kind 更新，连续触发 tick 累加', () => {
    const ws = useWorkspaceStore()
    ws.triggerCreate('character')
    expect(ws.createKind).toBe('character')
    const t1 = ws.createTick
    ws.triggerCreate('worldview')
    expect(ws.createKind).toBe('worldview')
    expect(ws.createTick).toBe(t1 + 1)
  })

  it('R8a-P2-1（2026-09-09 修复批）：非树面板下 triggerCreate → 先切回树面板，tick 延后一拍（面板挂载后再递增）', async () => {
    const ws = useWorkspaceStore()
    ws.leftPanel = 'search' // createTick 唯一消费者 ChapterTreePanel 只在树面板挂载
    const before = ws.createTick
    ws.triggerCreate()
    expect(ws.leftPanel).toBe('tree') // 切面板即时（新建意图指向树，切面板即用户可见反馈）
    expect(ws.createTick).toBe(before) // 未到 nextTick——此时递增必被零监听者错过
    await nextTick()
    expect(ws.createTick).toBe(before + 1)
  })

  it('R8a-P2-1：已在树面板 → tick 立即递增（延迟路径不误伤常规快径）', () => {
    const ws = useWorkspaceStore()
    const before = ws.createTick
    ws.triggerCreate('character')
    expect(ws.createTick).toBe(before + 1)
    expect(ws.leftPanel).toBe('tree')
  })
})

describe('workspace · 切书 debounce 竞态（ff 细节#11）', () => {
  it('500ms 内切书 → 挂起的 A 书落盘作废，不污染 B 书 prefs', async () => {
    const ws = useWorkspaceStore()
    ws.setBook('book-a')
    await flush() // A 书 prefs 加载完成 + watch 挂上
    ws.openTab('doc-a') // 触发 watch → 排定 500ms 后写 A 书 prefs
    ws.setBook('book-b') // 500ms 内切走（prefsLoaded=false + bookGen++）
    await flush() // 挂起定时器 fire
    // A 书的 activeDocId 不得写进 B 书（修复前：setTimeout 回调 fire 时读 bookName.value='book-b'）
    expect(bookPrefs.get('book-b') ?? {}).not.toMatchObject({ activeDocId: 'doc-a' })
    expect(bookPrefs.has('book-a')).toBe(false) // A 书也无残留写（切书即作废本次落盘）
  })

  it('不切书 → debounce 正常落盘（守卫不误伤常规路径）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    ws.openTab('d9')
    await flush()
    expect(bookPrefs.get(BOOK)).toMatchObject({ activeDocId: 'd9' })
  })
})

// R0911-C1-P3-3（2026-09-11 全量重评 GLM-5.3 修复批）：书级 prefs 500ms 防抖的关窗
// 冲刷——末次布局态此前随关窗静默丢失（R48-82 备案取舍收口）。冲刷 = 清挂起计时器后
// 直发写穿（Book.vue __clwFlushBeforeClose 调用，页面级接线见
// r0911-workspace-prefs-close-flush.test）；本组锚定 store 级语义：防抖窗内直写、
// 冲刷后计时器作废不二写、无待写项不空写。
describe('workspace · 关窗冲刷书级 prefs（R0911-C1-P3-3）', () => {
  it('防抖窗内（未满 500ms）触发冲刷 → 直接写穿落盘（不 advance 计时器）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush() // 加载 + 持久化 watch 挂上
    vi.mocked(putBookPrefs).mockClear()
    ws.openTab('d-close') // 排定 500ms 防抖（关窗时机落在窗内）
    await nextTick() // watch 为 pre-flush：等一拍让防抖计时器排上（不 advance 500ms）
    await ws.flushPendingBookPrefs()
    // 写穿断言：未经 advanceTimersByTime(500)，putBookPrefs 已带最新布局态落盘
    expect(putBookPrefs).toHaveBeenCalledTimes(1)
    expect(putBookPrefs).toHaveBeenCalledWith(BOOK, expect.objectContaining({ activeDocId: 'd-close' }))
    expect(bookPrefs.get(BOOK)).toMatchObject({ activeDocId: 'd-close' })
  })

  it('冲刷清掉挂起计时器 → 此后 advance 不再二写（防抖窗随冲刷消亡）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    ws.openTab('d-once')
    await nextTick() // 同上：等防抖计时器排上
    await ws.flushPendingBookPrefs()
    vi.mocked(putBookPrefs).mockClear()
    await flush() // 原防抖计时器若未清，此处会再写一次
    expect(putBookPrefs).not.toHaveBeenCalled()
  })

  it('无待写项（防抖窗空）→ 冲刷不空写', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    vi.mocked(putBookPrefs).mockClear()
    await ws.flushPendingBookPrefs()
    expect(putBookPrefs).not.toHaveBeenCalled()
  })

  it('冲刷失败 → 一次性 warning（R1010-P3 口径随写链外提保持）', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    ws.openTab('d-fail')
    await nextTick() // 同上：等防抖计时器排上
    vi.mocked(putBookPrefs).mockRejectedValueOnce(new Error('网络断了'))
    await ws.flushPendingBookPrefs()
    expect(toastSpy).toHaveBeenCalledWith('本书布局偏好暂时未能保存（网络/服务异常），恢复后将随下次调整自动重试', 'warning')
    // 冲刷链吞错不 reject（关窗钩子不被打断）
  })
})

// R-6（第十六轮）：书级 prefs 拉取失败 → 不置 prefsLoaded、不挂持久化 watch、
// 不做 localStorage 迁移写回——否则默认布局经 watch 覆盖服务端已存的 prefs.json
describe('workspace · R-6 prefs 拉取失败不覆盖已存 prefs', () => {
  it('getBookPrefs reject → openTab 变更不触发 putBookPrefs（下次进书可重试）', async () => {
    vi.mocked(getBookPrefs).mockRejectedValueOnce(new Error('API 不可达'))
    // 旧 localStorage 记录在场：拉取失败时不得被迁移写回（迁移只在 prefs.json 成功读到且为空时）
    localStorage.setItem('clw2.workspace.r6book', JSON.stringify({ activeDocId: 'd-old' }))
    const ws = useWorkspaceStore()
    ws.setBook('r6book')
    await flush()
    vi.mocked(putBookPrefs).mockClear()

    ws.openTab('d-new') // 默认布局下的变更（prefsLoaded 未置 → watch 不得写回）
    await flush()
    expect(putBookPrefs).not.toHaveBeenCalled() // 修复前：默认布局覆盖服务端 prefs.json
    expect(bookPrefs.has('r6book')).toBe(false)
  })
})

describe('workspace · 插入信号（第五轮 {text, tick}）', () => {
  it('同文本两次 requestInsert → tick 递增两次触发（同值赋值不再短路丢信号）', () => {
    const ws = useWorkspaceStore()
    ws.requestInsert('玉佩')
    const first = ws.pendingInsert
    expect(first?.text).toBe('玉佩')
    expect(first?.tick).toBeGreaterThan(0)
    ws.requestInsert('玉佩') // 同名再点——修复前字符串同值赋值不触发 watcher
    const second = ws.pendingInsert
    expect(second?.tick).toBeGreaterThan(first!.tick)
    expect(second).not.toBe(first) // 新引用，watcher 必触发
  })

  it('consumeInsert 取走并清空信号', () => {
    const ws = useWorkspaceStore()
    ws.requestInsert('设定名')
    const got = ws.consumeInsert()
    expect(got?.text).toBe('设定名')
    expect(ws.pendingInsert).toBeNull()
    expect(ws.consumeInsert()).toBeNull()
  })

  // FE-4（第七轮）：切书清插入信号——非编辑器视图点「插入」后切书，A 书设定名
  // 不能经新书编辑器 tryConsumeInsert 三口插进 B 书正文
  it('FE-4（第七轮）：setBook 切书 → pendingInsert 随之作废', async () => {
    const ws = useWorkspaceStore()
    ws.requestInsert('玉佩')
    expect(ws.pendingInsert).not.toBeNull()
    ws.setBook('B书')
    expect(ws.pendingInsert).toBeNull()
    await flush()
  })
})

// R26-79（二十六轮）：localStorage 迁移分支——treeExpanded 元素验 string（非 string
// 过滤）+ 迁移后清旧键（对齐 prefs store 的 clearLegacyLocalStorage 手法），不清则每次
// prefs.json 为空的新书都会重复走迁移分支。
describe('workspace · R26-79 迁移元素校验与旧键清理', () => {
  it('treeExpanded 混入非 string 元素 → 过滤后迁移；迁移写回后旧 localStorage 键被清', async () => {
    localStorage.setItem('clw2.ui-prefs', JSON.stringify({ leftWidth: 260 }))
    localStorage.setItem(`clw2.filetree.${BOOK}`, JSON.stringify(['写作', 42, null, '卷一']))
    localStorage.setItem(`clw2.workspace.${BOOK}`, JSON.stringify({ activeDocId: 'd-old' }))

    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()

    expect(ws.treeExpanded).toEqual(['写作', '卷一']) // 非法元素被过滤
    expect(bookPrefs.get(BOOK)).toMatchObject({ leftWidth: 260, treeExpanded: ['写作', '卷一'] })
    // 修复点：迁移完成即清旧键
    expect(localStorage.getItem('clw2.ui-prefs')).toBeNull()
    expect(localStorage.getItem(`clw2.workspace.${BOOK}`)).toBeNull()
    expect(localStorage.getItem(`clw2.filetree.${BOOK}`)).toBeNull()
  })

  it('无迁移数据（无旧键）→ 不触发清理路径，旧键语义不受影响', async () => {
    const ws = useWorkspaceStore()
    ws.setBook(BOOK)
    await flush()
    expect(bookPrefs.has(BOOK)).toBe(false) // 空迁移不写回
    expect(ws.treeExpanded).toEqual(['写作']) // 默认值
  })
})
