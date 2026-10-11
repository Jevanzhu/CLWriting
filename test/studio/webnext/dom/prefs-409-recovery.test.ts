/**
 * 全局偏好 409 冲突恢复行为族——按行为合并四散落文件
 * （原 r35-prefs-409-merge / r37-e27-prefs-409-apply / r40-prefs-409-retry-fail /
 * backlog-r61f3-prefs-dirty-without-baseline，装置同构：api/prefs 桩 + fake timers）。
 *
 * - R35-8（三十五轮）：恢复改「远端值垫底 + 本窗未落盘修改重放」。修复前（R33-73 口径）
 *   applyPrefs 整体采纳远端——本窗已改未落盘字段被静默丢弃；重试 PUT 脱离 putInFlight
 *   单飞。修复后：脏字段（当前 refs ≠ 最近成功落盘快照）重放本窗值，恢复与重试纳入单飞，
 *   toast 升 warning 如实描述。
 * - R37-27（三十七轮批E）：恢复后样式生效——applyPrefs 后接 applyTheme/applyCompact/apply
 *   三连（对齐 init() 恢复链），非本窗脏字段采纳远端新值后 CSS 变量/主题 dataset 同步。
 * - R40-41（四十轮）：恢复链三态告知——重试保存失败按 error toast 如实告知，不再
 *   无条件报「已保留本窗修改并合并」成功口径。
 * - R61-F-3（P3）：无已持久化基线（init 未完成，lastPersisted=null）时恢复 = 零本窗
 *   脏字段，整体采纳远端；默认值不整体回放（修复前 dirtyKeysOf 把 buildCache 全量键
 *   判为本窗脏回放覆盖远端）。
 * - 恢复链 GET 在途窗口：窗口内本窗新编辑不在本笔 PUT 快照里，合并须按「当前 refs ≠
 *   快照」把它覆盖回 merged——否则被 applyPrefs(merged) 回退成远端值，且回退态随即
 *   成为重试 PUT 的 body 与 lastPersisted 基线（编辑静默丢失 + 基线记错）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../../../../src/studio/web-next/src/api/prefs', () => ({
  getGlobalPrefs: vi.fn(),
  putGlobalPrefs: vi.fn(),
}))

import { getGlobalPrefs, putGlobalPrefs } from '../../../../src/studio/web-next/src/api/prefs'
import { ApiError } from '../../../../src/studio/web-next/src/api/client'
import { usePrefsStore } from '../../../../src/studio/web-next/src/stores/prefs'
import { useUiStore } from '../../../../src/studio/web-next/src/stores/ui'
import { installCrossWindowInvalidation } from '../../../../src/studio/web-next/src/composables/useCrossWindowInvalidation'
import { notifyCrossWindow, type CrossWindowPort } from '../../../../src/studio/web-next/src/shared/cross-window'
import { createLocalStorage } from '../../../helpers/local-storage.js'

const getMock = getGlobalPrefs as ReturnType<typeof vi.fn>
const putMock = putGlobalPrefs as ReturnType<typeof vi.fn>

function conflict409(): ApiError {
  return new ApiError('已在其他窗口被修改', 409)
}

// happy-dom localStorage 在 vitest 集成下缺 clear()，Map-backed 替身（prefs-store.test 同款）
const localStorageMock = createLocalStorage()
vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  localStorageMock.clear()
  vi.useFakeTimers()
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // 默认成功链：PUT 按传入 expectedRevision 自增（后续保存拿最新 revision）
  getMock.mockResolvedValue({ prefs: {}, revision: 0 })
  putMock.mockImplementation(async (_p, rev) => ({ ok: true as const, revision: (rev ?? 0) + 1 }))
  document.documentElement.style.setProperty('--prose-size', '')
})

afterEach(() => {
  vi.useRealTimers()
})

// ── R35-8：远端垫底 + 本窗未落盘修改重放 ────────────────────────

describe('prefs: 409 恢复——远端垫底 + 本窗未落盘修改重放（R35-8）', () => {
  it('本窗改 theme 未落盘 + 他窗改 pageWidth 先保存 → 恢复后两者并存，重试带远端 revision', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light', pageWidth: 1020, defaultGenre: '玄幻' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('theme', 'dark') // 本窗脏修改（防抖窗口内，尚未落盘）
    // 他窗抢先保存：pageWidth → 999，revision 5 → 6；首次 PUT 吃 409
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 999, defaultGenre: '玄幻' }, revision: 6 })

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // 修复点 1：本窗未落盘修改保留（修复前 applyPrefs 整体采纳远端 → theme 被改回 light）
    expect(prefs.get('theme')).toBe('dark')
    // 修复点 2：他窗字段合入（R33-73 语义保留）
    expect(prefs.get('pageWidth')).toBe(999)
    expect(putMock).toHaveBeenCalledTimes(2)
    // 修复点 3：重试 PUT 带远端最新 revision + 合并后的完整快照
    expect(putMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: 'dark', pageWidth: 999, defaultGenre: '玄幻' }),
      6,
    )
    // 修复点 4：toast 升 warning 且如实描述
    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('warning')
    expect(ui.toasts.at(-1)?.msg).toContain('其他窗口')
  })

  it('恢复窗口内的新保存排队到重试完成后发出（重试纳入 putInFlight 单飞），带最新 revision', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('theme', 'dark')
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    putMock.mockImplementationOnce(() => gate.then(() => Promise.reject(conflict409())))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', shelfView: 'list' }, revision: 1 })

    await vi.advanceTimersByTimeAsync(600) // 防抖到点：首次 PUT 挂起在 gate
    prefs.set('shelfView', 'list') // 恢复窗口内的新保存
    await vi.advanceTimersByTimeAsync(600) // 第二个防抖定时器到点：putInFlight 非空 → 重新排队
    expect(putMock).toHaveBeenCalledTimes(1) // 单飞：恢复链未完成，无并发 PUT

    release() // 放行首次 PUT → 409 → 恢复链（GET rev1 + 重试）
    await vi.advanceTimersByTimeAsync(1200) // 重试完成 + 排队的防抖到点
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // 第 2 笔 = 409 重试：合并本窗脏字段（theme/shelfView 均为本窗修改）+ 远端 rev
    expect(putMock.mock.calls[1]).toEqual([expect.objectContaining({ theme: 'dark', shelfView: 'list' }), 1])
    // 第 3 笔 = 排队保存：重试成功后以最新 revision（2）发出，不再吃 409
    expect(putMock.mock.calls[2]).toEqual([expect.objectContaining({ theme: 'dark', shelfView: 'list' }), 2])
  })

  it('无本窗脏字段 → 恢复整体采纳远端（远端垫底语义不回归）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    // 本窗无任何修改，仅其他窗口改了主题与排版
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    // 触发一笔与本窗无关的保存（snapDays 走 setter 也会置脏——改用直接 PUT：不需要；
    // 用 setSnapDays 制造一次保存，但随后远端 snapMaxDays 视为非脏会被远端覆盖）
    getMock.mockResolvedValueOnce({ prefs: { theme: 'dark', proseSize: 22 }, revision: 9 })

    prefs.set('snapDays', 45) // 本窗修改：snapDays
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.get('snapDays')).toBe(45) // 本窗脏字段重放
    expect(prefs.get('theme')).toBe('dark') // 非脏字段随远端
    expect(prefs.get('proseSize')).toBe(22)
    expect(putMock).toHaveBeenCalledTimes(2)
  })
})

// ── R37-27：恢复分支漏 apply——恢复后样式随之生效 ────────────────────────

describe('R37-27: 409 恢复分支漏 apply——恢复后样式随之生效', () => {
  it('远端改 proseSize/theme，本窗仅 snapDays 脏 → 恢复后 CSS 变量与主题 dataset 更新', async () => {
    // 初始：服务端 light + 默认字号（17px）——init 落一轮样式基线
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('proseSize')).toBe(17)
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('17px')
    expect(document.documentElement.dataset.theme).toBe('light')

    // 本窗脏字段：snapDays（防抖窗口内未落盘）；首笔 PUT 吃 409
    prefs.set('snapDays', 45)
    putMock.mockImplementationOnce(async () => Promise.reject(new ApiError('已在其他窗口被修改', 409)))
    // 恢复 GET：远端已改 theme=dark + proseSize=22（非本窗脏字段 → 采纳远端）
    getMock.mockResolvedValueOnce({ prefs: { theme: 'dark', proseSize: 22 }, revision: 1 })

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.get('proseSize')).toBe(22) // refs 已合并（R35-8 既有口径，对照组）
    // 修复点：样式同步生效（修复前 --prose-size 停留 17px、dataset.theme 停留 light）
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('22px')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(prefs.get('snapDays')).toBe(45) // 本窗脏字段重放（不回归）
  })

  it('对照组：init() 常规路径样式照常生效（基线锚定，防测试环境假阳性）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'dark', proseSize: 20 }, revision: 3 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(document.documentElement.style.getPropertyValue('--prose-size')).toBe('20px')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
})

// ── R40-41：恢复链三态告知 ────────────────────────

describe('R40-41: 恢复链三态告知', () => {
  it('重试保存失败 → error toast 如实告知，不再报成功', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('theme', 'dark')
    // 首笔 PUT 吃 409；恢复链 GET 拿到远端 rev1；重试 PUT 网络失败
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light' }, revision: 1 })
    putMock.mockImplementationOnce(async () => Promise.reject(new Error('网络中断')))

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(putMock).toHaveBeenCalledTimes(2) // 首笔 + 重试（都失败）
    const ui = useUiStore()
    const last = ui.toasts.at(-1)
    expect(last?.kind).toBe('error')
    expect(last?.msg).toContain('重试保存失败')
    // 不再有无条件的成功口径提示
    expect(ui.toasts.filter((t) => t.kind === 'warning' && t.msg.includes('已保留本窗修改并合并'))).toHaveLength(0)
    // 本窗脏修改仍保留（下次 schedulePersist 自动重试的语义基础）
    expect(prefs.get('theme')).toBe('dark')
  })

  it('重试成功 → 维持成功口径 warning（不回归）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 0 })
    const prefs = usePrefsStore()
    await prefs.init()

    prefs.set('theme', 'dark')
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 999 }, revision: 1 })

    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    const ui = useUiStore()
    expect(ui.toasts.at(-1)?.kind).toBe('warning')
    expect(ui.toasts.at(-1)?.msg).toContain('已保留本窗修改并合并')
    expect(prefs.get('pageWidth')).toBe(999)
  })
})

// ── 恢复链 await 窗口内的新编辑（GET 在途）不丢 ────────────────────────

describe('prefs: 409 恢复 GET 在途窗口内的新编辑不被回退', () => {
  it('恢复 GET 挂起期间本窗改的键 → 恢复后保留本窗新值（不回退成远端值），重试 PUT 带上它', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light', proseSize: 18 }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('proseSize')).toBe(18)

    prefs.set('theme', 'dark') // 本窗脏（防抖窗口内，尚未落盘）
    putMock.mockRejectedValueOnce(conflict409())
    // 恢复链的 GET 挂起——开出「GET 在途」窗口（回传 pending promise 的 mock 形态）
    let releaseGet!: (v: { prefs: Record<string, unknown>; revision: number }) => void
    const gate = new Promise<{ prefs: Record<string, unknown>; revision: number }>((r) => {
      releaseGet = r
    })
    getMock.mockReturnValueOnce(gate)
    await vi.advanceTimersByTimeAsync(600) // 首笔 PUT 吃 409 → 恢复链 GET 在途

    prefs.set('proseSize', 25) // 窗口内新编辑：本笔 PUT 快照（localCache）之外
    releaseGet({ prefs: { theme: 'light', proseSize: 18 }, revision: 6 })
    await vi.advanceTimersByTimeAsync(1200)
    for (let i = 0; i < 8; i++) await Promise.resolve()

    // 窗口内新编辑保留（回归点：不加合并覆盖时 applyPrefs(merged) 把 proseSize 回退成远端 18）
    expect(prefs.get('proseSize')).toBe(25)
    expect(prefs.get('theme')).toBe('dark')
    // 重试 PUT（第 2 笔）带窗口内新值——它同时是 lastPersisted 基线，基线不得记成回退态
    expect(putMock.mock.calls[1]).toEqual([expect.objectContaining({ theme: 'dark', proseSize: 25 }), 6])
    expect(putMock.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ proseSize: 25 }))
  })
})

// ── R61-F-3：无持久化基线的 409 恢复 ────────────────────────

describe('R61-F-3: 无持久化基线的 409 恢复——仅采纳远端，默认值不整体回放', () => {
  it('无基线态（init 未完成，lastPersisted=null）改一键触发 PUT 吃 409 → 远端非默认值采纳，本地默认值不整体回放', async () => {
    // 他窗已有配置：proseSize 22 / shelfView list（本窗 refs 此时全是默认值）
    getMock.mockResolvedValue({ prefs: { proseSize: 22, shelfView: 'list' }, revision: 6 })
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))

    // 不调 init()：lastPersisted 保持 null（无已持久化基线态）
    const prefs = usePrefsStore()
    prefs.set('theme', 'dark') // 本窗仅这一键触发保存（re-GET 对齐 → PUT → 409 → 恢复链）
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    // 修复点：无基线 = 零本窗脏字段 → 合并整体采纳远端。
    // 修复前 dirtyKeysOf 回 Object.keys(local) 全量判脏：本地默认 proseSize 17 /
    // shelfView 'grid' 当「本窗修改」回放，覆盖他窗配置
    expect(prefs.get('proseSize')).toBe(22)
    expect(prefs.get('shelfView')).toBe('list')
  })

  it('对照：init 失败（GET reject）完成态遇 409 → 远端非默认值采纳 + 本窗真实改动键保留（既有正确行为不回归）', async () => {
    getMock.mockRejectedValueOnce(new Error('down')) // init GET 失败 → else 分支置默认值快照基线
    const prefs = usePrefsStore()
    await prefs.init()
    expect(prefs.get('proseSize')).toBe(17) // init 失败降级默认

    // 他窗配置 proseSize 22；本窗仅真实改动 theme
    getMock.mockResolvedValue({ prefs: { proseSize: 22 }, revision: 6 })
    putMock.mockImplementationOnce(async () => Promise.reject(conflict409()))
    prefs.set('theme', 'dark')
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.get('proseSize')).toBe(22) // 远端非默认值采纳
    expect(prefs.get('theme')).toBe('dark') // 本窗真实改动键（唯一可判脏键）保留
  })
})

// ── 跨窗失效通知（prefs 线）────────────────────────────────────────
// 通道语义红线：广播只带「哪条线失效」（载荷无值），收到的一方必须走既有
// GET + applyPrefs 守卫 + 脏键合并链重取——不得把广播值塞进 store（绕过 revision
// 乐观并发闸）、不得吃掉本窗脏键、不得写回（PUT 会 bump revision → 他窗再收广播 → 回环）。

/** 可注入假通道：不依赖真实跨进程窗口；deliver = 模拟「他窗发来的消息」 */
function createFakePort(): {
  port: CrossWindowPort
  sent: unknown[]
  deliver: (data: unknown) => void
  closed: () => boolean
} {
  const listeners: ((data: unknown) => void)[] = []
  const sent: unknown[] = []
  let isClosed = false
  return {
    port: {
      postMessage: (msg) => void sent.push(msg),
      subscribe: (l) => {
        listeners.push(l)
        return () => {
          const i = listeners.indexOf(l)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
      close: () => {
        isClosed = true
      },
    },
    sent,
    deliver: (data) => {
      for (const l of [...listeners]) l(data)
    },
    closed: () => isClosed,
  }
}

describe('跨窗失效通知（prefs 线）', () => {
  let dispose: (() => void) | null = null
  afterEach(() => {
    dispose?.()
    dispose = null
  })

  it('通道可用：收到他窗 prefs 失效 → 走既有 GET 链重取（非脏键采纳远端），且不写回（不回环）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light', pageWidth: 1020 }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    const fake = createFakePort()
    const h = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 })
    dispose = h.dispose
    expect(h.enabled).toBe(true)

    // 他窗已改：远端 theme/proseSize 新值（广播载荷里没有任何值——只有失效主题）
    getMock.mockResolvedValueOnce({ prefs: { theme: 'dark', proseSize: 22 }, revision: 6 })
    fake.deliver({ v: 1, src: 'other-window', topics: ['prefs'] })
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(getMock).toHaveBeenCalledTimes(2) // init 1 次 + 失效触发的重取 1 次（既有 GET 链）
    expect(prefs.get('theme')).toBe('dark') // 值来自 GET 响应，不是广播载荷
    expect(prefs.get('proseSize')).toBe(22)
    expect(putMock).not.toHaveBeenCalled() // 刷新链不落盘：写回会 bump revision → 他窗再收广播 → 回环
    expect(fake.sent).toEqual([]) // 回环红线：收到通知触发的刷新链自身不再广播
    expect(document.documentElement.dataset.theme).toBe('dark') // 采纳远端后样式三连随落
  })

  it('本窗落盘成功后广播 prefs 失效（载荷无值：只有版本/来源/主题）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    const fake = createFakePort()
    const h = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 })
    dispose = h.dispose
    expect(fake.sent).toEqual([]) // init 未迁移（本地无旧值）：无广播

    prefs.set('snapDays', 45)
    await vi.advanceTimersByTimeAsync(600)
    expect(putMock).toHaveBeenCalledTimes(1)
    // 载荷逐位锁：只带协议头与主题——不携带任何偏好值（语义是失效通知，不是数据同步）
    expect(fake.sent).toEqual([{ v: 1, src: 'self', topics: ['prefs'] }])
  })

  it('本窗有脏键时收到他窗变更 → 脏值保持（不静默覆盖），远端值作垫底合入非脏键', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light', pageWidth: 1020 }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()
    prefs.set('theme', 'dark') // 本窗未落盘脏键（防抖窗内）

    const fake = createFakePort()
    dispose = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 }).dispose
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 999 }, revision: 6 })
    fake.deliver({ v: 1, src: 'other-window', topics: ['prefs'] })
    await vi.advanceTimersByTimeAsync(10)

    expect(prefs.get('theme')).toBe('dark') // 红线：本窗脏键不被远端值静默覆盖
    expect(prefs.get('pageWidth')).toBe(999) // 服务端值垫底，合入非脏键

    // 本窗脏键仍判脏：随既有防抖写落盘，PUT 快照带本窗脏值（合并不改落盘语义）
    await vi.advanceTimersByTimeAsync(600)
    expect(putMock).toHaveBeenCalledTimes(1)
    expect(putMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ theme: 'dark', pageWidth: 999 }))
  })

  it('采纳远端值后基线随之推进：后续 409 恢复不把它当本窗脏字段重放（不反向覆盖他窗新值）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light', pageWidth: 1020 }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    // 他窗改 pageWidth → 通知：本窗非脏键采纳 999，基线随之前移（999 不成本窗「脏」）
    const fake = createFakePort()
    dispose = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 }).dispose
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 999 }, revision: 6 })
    fake.deliver({ v: 1, src: 'other-window', topics: ['prefs'] })
    await vi.advanceTimersByTimeAsync(10)
    expect(prefs.get('pageWidth')).toBe(999)

    // 本窗改 theme 未落盘 → 首笔 PUT 吃 409；恢复链 GET 见 pageWidth 又被他窗改成 1234
    prefs.set('theme', 'dark')
    putMock.mockRejectedValueOnce(conflict409())
    getMock.mockResolvedValueOnce({ prefs: { theme: 'light', pageWidth: 1234 }, revision: 7 })
    await vi.advanceTimersByTimeAsync(600)
    for (let i = 0; i < 5; i++) await Promise.resolve()

    expect(prefs.get('pageWidth')).toBe(1234) // 修复点：基线未推进时 999 被判本窗脏重放，盖掉 1234
    expect(prefs.get('theme')).toBe('dark') // 本窗真实脏键照旧保留
  })

  it('本窗自己的消息被忽略（来源窗 id 自检）——不触发任何重取', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    const fake = createFakePort()
    const h = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 })
    dispose = h.dispose
    fake.deliver({ v: 1, src: h.windowId, topics: ['prefs'] })
    await vi.advanceTimersByTimeAsync(10)

    expect(getMock).toHaveBeenCalledTimes(1) // 只有 init 那次；自窗消息不进刷新链
    expect(prefs.get('theme')).toBe('light')
  })

  it('版本号不符 / 未登记主题 / 非对象载荷一律丢弃（跨窗载荷不受信）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    const fake = createFakePort()
    dispose = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 }).dispose
    fake.deliver({ v: 99, src: 'other-window', topics: ['prefs'] })
    fake.deliver({ v: 1, src: 'other-window', topics: ['未登记主题'] })
    fake.deliver({ v: 1, src: 'other-window', topics: 'prefs' })
    fake.deliver('garbage')
    await vi.advanceTimersByTimeAsync(10)

    expect(getMock).toHaveBeenCalledTimes(1) // 全被丢弃：无重取
    expect(prefs.get('theme')).toBe('light')
  })

  it('同一 tick 内多条他窗通知按主题并集合并为一次重取（多窗同时改不风暴）', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    const fake = createFakePort()
    dispose = installCrossWindowInvalidation({ windowId: 'self', createPort: () => fake.port, coalesceMs: 0 }).dispose
    fake.deliver({ v: 1, src: 'w1', topics: ['prefs'] })
    fake.deliver({ v: 1, src: 'w2', topics: ['prefs', 'tree-issues'] })
    fake.deliver({ v: 1, src: 'w3', topics: ['prefs'] })
    await vi.advanceTimersByTimeAsync(10)

    expect(getMock).toHaveBeenCalledTimes(2) // init 1 次 + 合并后 1 次（三条通知不产生三次重取）
    expect(prefs.get('theme')).toBe('light')
  })

  it('通道不可用（工厂返回 null）→ 装配不抛（enabled=false）、广播 no-op、既有保存链照旧', async () => {
    getMock.mockResolvedValue({ prefs: { theme: 'light' }, revision: 5 })
    const prefs = usePrefsStore()
    await prefs.init()

    const h = installCrossWindowInvalidation({ createPort: () => null })
    dispose = h.dispose
    expect(h.enabled).toBe(false)
    expect(() => notifyCrossWindow(['prefs'])).not.toThrow()

    prefs.set('snapDays', 45) // 功能照旧：通道缺失不影响既有 setter → 防抖 → PUT 链
    await vi.advanceTimersByTimeAsync(600)
    expect(putMock).toHaveBeenCalledTimes(1)
    expect(prefs.get('snapDays')).toBe(45)
  })
})
