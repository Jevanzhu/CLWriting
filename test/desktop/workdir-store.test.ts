/**
 * R26-93（二十六轮）：filterValidRecent 补 isDirectory 校验。
 * existsSync 对「同路径普通文件」也为 true：书库目录被同名文件顶替时该 recent 项
 * 不再可用，却原样保留 → 点击切换后把文件路径当书库目录用。纯函数直测。
 * R1010-P2-1（2026-09-10 全量重评 GLM-5.3 修复批）：同步版改 filterValidRecentBudgeted
 * （fs/promises stat + 超时预算）——既有目录有效性臂全量迁移（await 真实临时目录），
 * 另补「stat 挂起（失联网络卷）超时保留展示」回归臂（注入永不 settle 的 stat）。
 *
 * 2026-10-01 并档（test 目录按子域收编）：原 test/studio/workdir-store.test.ts 的
 * parseStore/setCurrent/serialize/失效清理臂并入本档——同一被测模块（src/desktop/
 * workdir-store.ts）两处各测一半，改语义要跑两个目录；并档后单处可读全貌。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  parseStore,
  setCurrent,
  rollbackStore,
  serializeStore,
  createReachabilityBreaker,
  MAX_RECENT,
  filterValidRecentBudgeted,
  emptyStore,
  type WorkDirStore,
  type StatLike,
} from '../../src/desktop/workdir-store.js'

let tmp: string
let realDir: string
let fileImpostor: string
let missing: string

beforeEach(() => {
  tmp = mkdtempTracked(join(tmpdir(), 'clw-workdir-store-'))
  realDir = join(tmp, '真书库')
  mkdirSync(realDir)
  // 同名「文件」顶替书库目录的形态（R26-93 核心场景）
  fileImpostor = join(tmp, '顶替文件')
  writeFileSync(fileImpostor, 'not a dir')
  missing = join(tmp, '已消失的书库')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function storeWith(recent: Array<{ path: string; label: string }>, current: string | null = null): WorkDirStore {
  return { ...emptyStore(), current, recent }
}

describe('R26-93：filterValidRecentBudgeted 目录有效性', () => {
  it('存在目录保留；不存在剔除（原语义保留）', async () => {
    const r = await filterValidRecentBudgeted(
      storeWith([
        { path: realDir, label: '真书库' },
        { path: missing, label: '已消失' },
      ]),
    )
    expect(r.recent.map((x) => x.path)).toEqual([realDir])
  })

  it('核心回归：路径是普通文件（非目录）→ 剔除（修复前 existsSync 误判有效）', async () => {
    const r = await filterValidRecentBudgeted(
      storeWith([
        { path: fileImpostor, label: '顶替文件' },
        { path: realDir, label: '真书库' },
      ]),
    )
    expect(r.recent.map((x) => x.path)).toEqual([realDir])
  })

  it('current 不在本函数处理面（失效也原样透传，由调用方决定重选）', async () => {
    const r = await filterValidRecentBudgeted(storeWith([{ path: realDir, label: '真书库' }], missing))
    expect(r.current).toBe(missing)
    expect(r.recent).toHaveLength(1)
  })

  it('全部失效 → recent 清空不抛；空存储直通', async () => {
    const r = await filterValidRecentBudgeted(
      storeWith([
        { path: missing, label: 'x' },
        { path: fileImpostor, label: 'y' },
      ]),
    )
    expect(r.recent).toEqual([])
    expect((await filterValidRecentBudgeted(emptyStore())).recent).toEqual([])
  })
})

describe('R1010-P2-1：失联网络卷超时保留（启动不冻结）', () => {
  it('stat 挂起（挂载点在而服务器无响应）→ 超时跳过判定保留展示，调用方不无限等待', async () => {
    const hungStat: StatLike = () => new Promise(() => {}) // 永不 settle
    const startedAt = Date.now()
    const r = await filterValidRecentBudgeted(
      storeWith([
        { path: '/mnt/nas/书库A', label: '书库A' },
        { path: realDir, label: '真书库' },
      ]),
      { timeoutMs: 20, stat: hungStat },
    )
    // 全量挂起形态（整册 recent 都在失联卷上）：条目按超时保留（失联≠失效，择库守卫
    // 兜底），且预算内返回——修复前同步版此处是永不返回的冻结
    expect(r.recent.map((x) => x.path)).toEqual(['/mnt/nas/书库A', realDir])
    expect(Date.now() - startedAt).toBeLessThan(5_000) // 不被挂起 stat 冻住（预算内返回）
  })

  it('注入确定性快速失败（ENOENT 形态）→ 剔除（超时保留只认超时哨兵）', async () => {
    const failingStat: StatLike = (p) =>
      p === realDir
        ? Promise.resolve({ isDirectory: () => true })
        : Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' }))
    const r = await filterValidRecentBudgeted(
      storeWith([
        { path: realDir, label: '真书库' },
        { path: '/gone/书库B', label: '书库B' },
      ]),
      { timeoutMs: 1_000, stat: failingStat },
    )
    expect(r.recent.map((x) => x.path)).toEqual([realDir])
  })
})

describe('workdir-store parseStore（容错）', () => {
  it('正常 JSON → store', () => {
    const raw = JSON.stringify({ current: '/A', recent: [{ path: '/B', label: 'B' }] })
    expect(parseStore(raw)).toEqual({ current: '/A', recent: [{ path: '/B', label: 'B' }] })
  })

  it('损坏 JSON → 空存储', () => {
    expect(parseStore('{不是合法json')).toEqual(emptyStore())
  })

  it('非对象 JSON → 空存储', () => {
    expect(parseStore('"字符串"')).toEqual(emptyStore())
    expect(parseStore('123')).toEqual(emptyStore())
    expect(parseStore('null')).toEqual(emptyStore())
  })

  it('current 非字符串 → null', () => {
    expect(parseStore(JSON.stringify({ current: 123, recent: [] })).current).toBeNull()
  })

  it('recent 非法项过滤（缺字段/类型错）', () => {
    const raw = JSON.stringify({
      current: '/A',
      recent: [
        { path: '/B', label: 'B' }, // 合法
        { path: '/C' }, // 缺 label
        { label: 'D' }, // 缺 path
        'not-object', // 非对象
      ],
    })
    expect(parseStore(raw).recent).toEqual([{ path: '/B', label: 'B' }])
  })

  it('recent 去重 + 截断 MAX_RECENT', () => {
    const recent = Array.from({ length: MAX_RECENT + 3 }, (_, i) => ({
      path: `/p${i}`,
      label: `p${i}`,
    }))
    recent.push({ path: '/p0', label: 'dup' }) // 重复 p0
    const result = parseStore(JSON.stringify({ current: null, recent }))
    const paths = result.recent.map((r) => r.path)
    expect(new Set(paths).size).toBe(paths.length) // 去重
    expect(result.recent.length).toBe(MAX_RECENT) // 截断
  })
})

describe('workdir-store setCurrent（切换 + 最近列表）', () => {
  it('首次设 current → 空 recent', () => {
    expect(setCurrent(emptyStore(), '/A')).toEqual({ current: '/A', recent: [] })
  })

  it('切换新值：旧 current 推入 recent 头部', () => {
    const s = setCurrent(emptyStore(), '/A')
    expect(setCurrent(s, '/B')).toEqual({
      current: '/B',
      recent: [{ path: '/A', label: 'A' }],
    })
  })

  it('label = 目录 basename', () => {
    const s = setCurrent(emptyStore(), '/Users/x/MyNovels')
    expect(setCurrent(s, '/other').recent[0]).toEqual({
      path: '/Users/x/MyNovels',
      label: 'MyNovels',
    })
  })

  it('同值切换是 no-op（不把自己塞进 recent）', () => {
    const s = { current: '/A', recent: [{ path: '/B', label: 'B' }] }
    expect(setCurrent(s, '/A')).toEqual(s)
  })

  it('切回 recent 中的值：从 recent 提升，旧 current 入头部', () => {
    const s1 = setCurrent(setCurrent(setCurrent(emptyStore(), '/A'), '/B'), '/C')
    // s1 = { current: '/C', recent: [{B},{A}] }
    const s2 = setCurrent(s1, '/A')
    expect(s2.current).toBe('/A')
    expect(s2.recent).toEqual([
      { path: '/C', label: 'C' },
      { path: '/B', label: 'B' },
    ])
  })

  it('连续切换 recent 截断 MAX_RECENT，且不含当前 current', () => {
    let s = emptyStore()
    for (let i = 0; i < MAX_RECENT + 3; i++) s = setCurrent(s, `/p${i}`)
    expect(s.current).toBe(`/p${MAX_RECENT + 2}`)
    expect(s.recent.length).toBe(MAX_RECENT)
    expect(s.recent.every((r) => r.path !== s.current)).toBe(true)
  })
})

describe('workdir-store serialize（序列化往返）', () => {
  it('serialize → parse 往返一致', () => {
    const s = { current: '/A', recent: [{ path: '/B', label: 'B' }] }
    expect(parseStore(serializeStore(s))).toEqual(s)
  })

  it('serialize 带 pretty 缩进 + 尾换行', () => {
    const out = serializeStore({ current: '/A', recent: [] })
    expect(out.endsWith('\n')).toBe(true)
    expect(out).toContain('\n  ') // 2 空格缩进
  })
})

describe('rollbackStore（切库取消回滚的锁内合并）', () => {
  it('正常回滚（无并发）：本次切换写盘的「旧 current 顶进 recent 头」不与快照冲突 → 输出与快照逐位相等', () => {
    const snapshot: WorkDirStore = {
      current: '/libs/A',
      recent: [
        { path: '/libs/B', label: 'B' },
        { path: '/libs/C', label: 'C' },
      ],
    }
    // 盘上 = 本次切库落盘后的真身：current 换成了 D、A 被顶进 recent 头
    const disk: WorkDirStore = {
      current: '/libs/D',
      recent: [
        { path: '/libs/A', label: 'A' },
        { path: '/libs/B', label: 'B' },
        { path: '/libs/C', label: 'C' },
      ],
    }
    expect(rollbackStore(disk, snapshot)).toEqual(snapshot)
  })

  it('回滚基线为 welcome 态（current=null）时同样逐位还原：快照满员被本次切换挤掉的尾项也回来', () => {
    const snapshot: WorkDirStore = {
      current: null,
      recent: Array.from({ length: MAX_RECENT }, (_, i) => ({ path: `/libs/s${i}`, label: `s${i}` })),
    }
    // welcome 态切库：无旧 current 可顶入，setCurrent 只是剔除目标库 D 再截断
    const disk: WorkDirStore = { current: '/libs/D', recent: snapshot.recent.slice(0, MAX_RECENT - 1) }
    expect(rollbackStore(disk, snapshot)).toEqual(snapshot)
  })

  it('盘上就是快照（本次写盘未发生）→ 原样返回快照对象，不重排不归一', () => {
    const snapshot: WorkDirStore = {
      current: null,
      // 手改文件形态：current 混在 recent、且含重复项——不变量本就不成立，逐字保留
      recent: [
        { path: '/libs/A', label: 'A' },
        { path: '/libs/A', label: 'dup' },
      ],
    }
    expect(rollbackStore({ ...snapshot, recent: [...snapshot.recent] }, snapshot)).toEqual(snapshot)
  })

  it('盘上完全空（首启无文件/外部清空）→ 与按快照整写等价', () => {
    const snapshot: WorkDirStore = { current: '/libs/A', recent: [{ path: '/libs/B', label: 'B' }] }
    expect(rollbackStore(emptyStore(), snapshot)).toEqual(snapshot)
  })

  it('他实例在窗口内新增的 recent 条目保留，current 归位到快照值', () => {
    const snapshot: WorkDirStore = { current: '/libs/A', recent: [] }
    // 另一实例（另一库窗口）在「快照读取 → 回滚」窗口内落盘 C
    const disk: WorkDirStore = { current: '/libs/D', recent: [{ path: '/libs/C', label: 'C' }] }
    const merged = rollbackStore(disk, snapshot)
    expect(merged.current).toBe('/libs/A')
    expect(merged.recent.map((r) => r.path)).toEqual(['/libs/C'])
  })

  it('快照满员而盘上另有新增 → 新增不被上限挤掉（截断落在最旧的快照尾项）', () => {
    const snapshot: WorkDirStore = {
      current: '/libs/A',
      recent: Array.from({ length: MAX_RECENT }, (_, i) => ({ path: `/libs/s${i}`, label: `s${i}` })),
    }
    const disk: WorkDirStore = {
      current: '/libs/D',
      recent: [
        { path: '/libs/A', label: 'A' }, // 本次切换顶入（= 回滚后 current，剔除）
        { path: '/libs/new1', label: 'new1' }, // 他实例并发新增
        ...snapshot.recent,
      ],
    }
    const merged = rollbackStore(disk, snapshot)
    const paths = merged.recent.map((r) => r.path)
    expect(paths[0], '并发新增排在头部（最近在前）').toBe('/libs/new1')
    expect(paths.length).toBe(MAX_RECENT) // 上限不放宽
    expect(paths).not.toContain('/libs/A') // current 不入 recent
    expect(paths).toEqual(['/libs/new1', ...snapshot.recent.slice(0, MAX_RECENT - 1).map((r) => r.path)])
  })

  it('快照 current 为 null（welcome 态回滚）→ recent 保留盘上条目、current 回到 null', () => {
    const disk: WorkDirStore = {
      current: '/libs/D',
      recent: [
        { path: '/libs/A', label: 'A' },
        { path: '/libs/C', label: 'C' },
      ],
    }
    const merged = rollbackStore(disk, emptyStore())
    expect(merged.current).toBeNull()
    expect(merged.recent.map((r) => r.path)).toEqual(['/libs/A', '/libs/C'])
  })

  it('合并剔除与回滚后 current 同库的 recent 项（不变量与 setCurrent 同口径）', () => {
    const snapshot: WorkDirStore = { current: '/libs/A', recent: [] }
    const disk: WorkDirStore = {
      current: '/libs/D',
      recent: [
        { path: '/libs/A', label: 'A' }, // = 回滚后的 current，不得留在 recent
        { path: '/libs/C', label: 'C' },
      ],
    }
    expect(rollbackStore(disk, snapshot).recent.map((r) => r.path)).toEqual(['/libs/C'])
  })
})

describe('createReachabilityBreaker（预探熔断：窗口内不再发起新探测）', () => {
  /** 注入时钟：窗口推进不真等（熔断窗口是分钟档，测试须确定性快进） */
  function fakeClock(): { now: () => number; advance: (ms: number) => void } {
    let t = 1_000_000
    return { now: () => t, advance: (ms) => (t += ms) }
  }

  it('未 trip 的键恒不开；trip 后在窗口内开、到期自动关（键表不留过期项）', () => {
    const clock = fakeClock()
    const b = createReachabilityBreaker({ ttlMs: () => 30_000, now: clock.now })
    expect(b.isOpen('/libs/A')).toBe(false)
    b.trip('/libs/A')
    expect(b.isOpen('/libs/A')).toBe(true)
    clock.advance(29_999)
    expect(b.isOpen('/libs/A')).toBe(true)
    clock.advance(1)
    expect(b.isOpen('/libs/A')).toBe(false) // 窗口边界即失效（>= ttl）
  })

  it('键按路径区分：一个失联库不牵连其它库（多库多窗）', () => {
    const clock = fakeClock()
    const b = createReachabilityBreaker({ ttlMs: () => 30_000, now: clock.now })
    b.trip('/mnt/nas/书库A')
    expect(b.isOpen('/mnt/nas/书库A')).toBe(true)
    expect(b.isOpen('/home/u/书库B')).toBe(false) // 同窗口内他库照常真探
  })

  it('同键重 trip 刷新窗口（卷仍无响应时窗口滚动，不中途放开）', () => {
    const clock = fakeClock()
    const b = createReachabilityBreaker({ ttlMs: () => 30_000, now: clock.now })
    b.trip('/libs/A')
    clock.advance(20_000)
    b.trip('/libs/A') // 窗口内又记一次（调用方在窗口过窗后的首次真探超时）
    clock.advance(20_000) // 距首次 40s、距二次 20s
    expect(b.isOpen('/libs/A')).toBe(true)
    clock.advance(10_000)
    expect(b.isOpen('/libs/A')).toBe(false)
  })

  it('键表容量封顶：逐出最旧键只降熔断面，不改变任何判定结果', () => {
    const clock = fakeClock()
    const b = createReachabilityBreaker({ ttlMs: () => 30_000, now: clock.now, maxKeys: 2 })
    b.trip('/a')
    b.trip('/b')
    b.trip('/c') // 超限：最旧的 /a 被逐出
    expect(b.isOpen('/a')).toBe(false) // 退化为「下次照常真探」，不误判
    expect(b.isOpen('/b')).toBe(true)
    expect(b.isOpen('/c')).toBe(true)
  })
})
