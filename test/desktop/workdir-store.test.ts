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
  serializeStore,
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
