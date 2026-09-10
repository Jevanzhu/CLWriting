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
    store.appendEvent(sid, { type: 'step/start', data: { i: 1 } })
    store.appendEvent(sid, { type: 'llm/call', data: { task: 'x' } })
    store.appendEvent(sid, { type: 'step/end', data: { i: 2 } })

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
