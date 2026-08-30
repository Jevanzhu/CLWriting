/**
 * R26-93（二十六轮）：filterValidRecent 补 isDirectory 校验。
 * existsSync 对「同路径普通文件」也为 true：书库目录被同名文件顶替时该 recent 项
 * 不再可用，却原样保留 → 点击切换后把文件路径当书库目录用。纯函数直测。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterValidRecent, emptyStore, type WorkDirStore } from '../../src/desktop/workdir-store.js'

let tmp: string
let realDir: string
let fileImpostor: string
let missing: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-workdir-store-'))
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

describe('R26-93：filterValidRecent 目录有效性', () => {
  it('存在目录保留；不存在剔除（原语义保留）', () => {
    const r = filterValidRecent(storeWith([
      { path: realDir, label: '真书库' },
      { path: missing, label: '已消失' },
    ]))
    expect(r.recent.map((x) => x.path)).toEqual([realDir])
  })

  it('核心回归：路径是普通文件（非目录）→ 剔除（修复前 existsSync 误判有效）', () => {
    const r = filterValidRecent(storeWith([
      { path: fileImpostor, label: '顶替文件' },
      { path: realDir, label: '真书库' },
    ]))
    expect(r.recent.map((x) => x.path)).toEqual([realDir])
  })

  it('current 不在本函数处理面（失效也原样透传，由调用方决定重选）', () => {
    const r = filterValidRecent(storeWith([{ path: realDir, label: '真书库' }], missing))
    expect(r.current).toBe(missing)
    expect(r.recent).toHaveLength(1)
  })

  it('全部失效 → recent 清空不抛；空存储直通', () => {
    const r = filterValidRecent(storeWith([{ path: missing, label: 'x' }, { path: fileImpostor, label: 'y' }]))
    expect(r.recent).toEqual([])
    expect(filterValidRecent(emptyStore()).recent).toEqual([])
  })
})
