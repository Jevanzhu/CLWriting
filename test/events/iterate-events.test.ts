/**
 * R0910-W（2026-09-10 修复批）回归：SessionStore.iterateEvents 流式读 API。
 *
 * 新增只读导出（成本/轨迹分析读侧改流式用）：无 limit、seq 升序逐行 yield，不物化
 * 全量数组；语义须与 listEvents 无 limit 变体逐字段一致（同 SQL、同坏行降级），
 * 否则分析聚合结果会漂移。本用例守护二者等价。
 */
import { test, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function temp(prefix: string): string {
  return mkdtempTracked(join(tmpdir(), prefix))
}

test('R0910-W：iterateEvents 与 listEvents 全量语义一致（全量 / type 过滤 / session 过滤）', () => {
  const user = temp('clw-it-ud-')
  const root = temp('clw-it-book-')
  const store = openSessionStore(user, root)!
  try {
    const book = bookHash(root)
    const sid = store.workspaceSession(book)
    store.appendEvents(sid, [{ type: 'step/start', data: { i: 1 } }])
    store.appendEvents(sid, [{ type: 'llm/call', data: { task: 'x' } }])
    store.appendEvents(sid, [{ type: 'step/end', data: { i: 2 } }])
    // 全量（book 级）
    expect([...store.iterateEvents(book)]).toEqual(store.listEvents(book))
    // type 过滤
    expect([...store.iterateEvents(book, undefined, 'llm/call')]).toEqual(
      store.listEvents(book, undefined, undefined, 'llm/call'),
    )
    // session 过滤
    expect([...store.iterateEvents(book, sid)]).toEqual(store.listEvents(book, sid))
    // seq 升序
    const seqs = [...store.iterateEvents(book)].map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  } finally {
    store.close()
    rmSync(user, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('R0916-P3-11：iterateEvents 重入安全——外层迭代中再开同 SQL 迭代，两层各自完整', () => {
  const user = temp('clw-it-ud-')
  const root = temp('clw-it-book-')
  const store = openSessionStore(user, root)!
  try {
    const book = bookHash(root)
    const sid = store.workspaceSession(book)
    for (let i = 0; i < 6; i++) store.appendEvents(sid, [{ type: 'step/start', data: { i } }])
    // 修复前：两路共用 prepared 缓存语句，内层 .iterate() 令外层迭代器被 node:sqlite
    // 判失效（ERR_INVALID_STATE，2026-09-16 node 26 实证）；修复后流式路径每次新编译
    // 语句，两层互不干扰。book 级 / session 过滤两腿 SQL 形态都各走各的语句。
    let outer = 0
    for (const _ of store.iterateEvents(book)) {
      outer++
      let inner = 0
      for (const _i of store.iterateEvents(book)) inner++
      expect(inner).toBe(6)
      let innerS = 0
      for (const _s of store.iterateEvents(book, sid)) innerS++
      expect(innerS).toBe(6)
    }
    expect(outer).toBe(6)
    // listEvents 缓存路径不受影响（表达式内同步排干，语句生命周期不越出单次调用）
    expect(store.listEvents(book)).toHaveLength(6)
  } finally {
    store.close()
    rmSync(user, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
