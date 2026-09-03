/**
 * R41-11（四十一轮修复批）回归：事件库迁移墓碑原子写 + 不可解析墓碑 fail-closed。
 *
 * 原缺陷形态：墓碑裸 writeFileSync 写中途进程死 → 半截 JSON 滞留旧位；消费侧
 * （firstOpenStore 墓碑分支）把解析失败当「无指向」清除放行 → 迟来首开按正常
 * 缺库在旧路径重建空库（R71-25 要防的事件流分裂照样发生）。
 *
 * 修复后双防线：
 * ① 写侧 atomicWriteFile（tmp + rename，要么完整要么不在）；
 * ② 消费侧不可解析墓碑保留 + fail-closed 抛错拒建空库（走调用方既有 catch 降级）。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

describe('R41-11: 事件库迁移墓碑完整性', () => {
  it('不可解析墓碑（半截 JSON）→ 首开 fail-closed 抛错，墓碑保留且不建空库', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'r41-tomb-'))
    const oldRoot = '/books/裂开的墓碑'
    const dir = join(ud, 'clwriting', 'session')
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, bookHash(oldRoot) + '.db')
    // 半截 JSON（写中途进程死形态；写侧已原子化，此为存量/外因）
    writeFileSync(dbPath + '.migrated', '{"to": "/books/新', 'utf-8')
    try {
      // 修复前：解析失败被吞 → 墓碑被清除 → 旧路径重建空库（事件流分裂）
      expect(() => openSessionStore(ud, oldRoot)).toThrow(/墓碑不可解析/)
      // 墓碑保留（供人工核对），且未在旧路径建出空库
      expect(existsSync(dbPath + '.migrated')).toBe(true)
      expect(existsSync(dbPath)).toBe(false)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('可解析墓碑的既有两态不受影响（bookRoot 在 → 过期清除放行新建）', () => {
    const ud = mkdtempTracked(join(tmpdir(), 'r41-tomb-'))
    const oldRoot = join(ud, '回来的书') // bookRoot 存在 = 同路径重新建书场景
    mkdirSync(oldRoot, { recursive: true })
    const dir = join(ud, 'clwriting', 'session')
    mkdirSync(dir, { recursive: true })
    const dbPath = join(dir, bookHash(oldRoot) + '.db')
    writeFileSync(dbPath + '.migrated', JSON.stringify({ to: '/books/别处', at: 1 }), 'utf-8')
    try {
      const store = openSessionStore(ud, oldRoot)
      expect(store).not.toBeNull()
      store!.close()
      // 过期墓碑被清除，新库在旧路径正常建立
      expect(existsSync(dbPath + '.migrated')).toBe(false)
      expect(existsSync(dbPath)).toBe(true)
    } finally {
      rmSync(ud, { recursive: true, force: true })
    }
  })

  it('写侧静态扫描：墓碑预写走 atomicWriteFile（tmp+rename，不再裸 writeFileSync）', () => {
    const src = readFileSync(join(import.meta.dirname, '../../src/events/store.ts'), 'utf-8')
    expect(src.includes('atomicWriteFile(oldDb + MIGRATED_EXT')).toBe(true)
    // 裸写形态若回归（同调用点 writeFileSync(oldDb + MIGRATED_EXT)）即红
    expect(src.includes('writeFileSync(oldDb + MIGRATED_EXT')).toBe(false)
  })
})
