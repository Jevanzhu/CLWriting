/**
 * workdir-store 纯函数测试（桌面化工作目录管理，批1）。
 *
 * 验证持久化数据变换：解析容错 / 切换去重截断 / 失效路径过滤。
 * 零 Electron 依赖（纯数据）；filterValidRecent 用真实临时目录验 existsSync。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseStore,
  setCurrent,
  emptyStore,
  serializeStore,
  filterValidRecent,
  MAX_RECENT,
} from '../../src/desktop/workdir-store.js'

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

describe('workdir-store filterValidRecent（失效清理）', () => {
  let alive = ''
  beforeEach(() => {
    alive = mkdtempSync(join(tmpdir(), 'clwriting-wd-'))
  })
  afterEach(() => {
    if (alive) rmSync(alive, { recursive: true, force: true })
  })

  it('过滤掉不存在的目录，保留存在的', () => {
    const s = {
      current: '/current',
      recent: [
        { path: alive, label: 'alive' },
        { path: '/not-exist-xyz-123', label: 'gone' },
      ],
    }
    const result = filterValidRecent(s)
    expect(result.recent).toEqual([{ path: alive, label: 'alive' }])
    expect(result.current).toBe('/current') // current 不受影响
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
