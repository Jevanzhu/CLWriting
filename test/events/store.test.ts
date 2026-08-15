/**
 * F1-P1 事件库存取层单测：建库/写入/读取/清空/启动修复。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'f1-store-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('F1-P1 bookHash', () => {
  it('稳定且不同路径不同', () => {
    const a = bookHash('/books/a')
    expect(bookHash('/books/a')).toBe(a)
    expect(bookHash('/books/b')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })
});

describe('F1-P1 store 存取', () => {
  it('userDataPath 为空 → null（退化内存模式）', () => {
    expect(openSessionStore(null, '/books/a')).toBeNull()
    expect(openSessionStore(undefined, '/books/a')).toBeNull()
  })

  it('appendEvents 落库且 seq 连续；listEvents 按 seq 升序返回', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A', { book: '书A' })
    store.appendEvents(sid, [
      { type: 'session/start', data: { book: '书A' } },
      { type: 'user/message', data: { message: 'hi' }, surfaceOp: 'append' },
    ])
    expect(store.lastSeq()).toBe(2)
    const evs = store.listEvents('书A')
    expect(evs.map((e) => e.seq)).toEqual([1, 2])
    expect(evs[0]!.type).toBe('session/start')
    expect(evs[1]!.type).toBe('user/message')
    expect(evs[1]!.data['message']).toBe('hi')
    store.close()
  })

  it('listEvents 可按 sessionId 过滤', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const s1 = store.createSession('书A')
    const s2 = store.createSession('书A')
    store.appendEvent(s1, { type: 'user/message', data: { message: 'm1' }, surfaceOp: 'append' })
    store.appendEvent(s2, { type: 'user/message', data: { message: 'm2' }, surfaceOp: 'append' })
    expect(store.listEvents('书A', s1).map((e) => e.data['message'])).toEqual(['m1'])
    expect(store.listEvents('书A').map((e) => e.data['message'])).toEqual(['m1', 'm2'])
    store.close()
  })

  it('clearBook 清空本书事件与 session', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' })
    expect(store.lastSeq()).toBe(1)
    store.clearBook('书A')
    expect(store.listEvents('书A')).toHaveLength(0)
    expect(store.lastSeq()).toBe(0)
    store.close()
  })

  it('失败事务回滚——appendEvents 抛错后无部分写入', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    // 触发错误：未知 type 不报错（SQLite 不校验），改用 data 为不可序列化对象
    const bad: Record<string, unknown> = {}
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => store.appendEvents(sid, [{ type: 'user/message', data: cyc, surfaceOp: 'append' }])).toThrow()
    expect(store.listEvents('书A')).toHaveLength(0)
    void bad;
    store.close()
  })
})

describe('F1-P1 启动修复', () => {
  it('孤儿 session（有 start 无 end）重开库时补 session/end{interrupted}', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: { book: '书A' } })
    store.appendEvent(sid, { type: 'user/message', data: { message: 'crash' }, surfaceOp: 'append' })
    store.close()
    // 重开库（模拟崩溃后重启）
    const store2 = openSessionStore(ud, '/books/a')!;
    const evs = store2.listEvents('书A')
    const ends = evs.filter((e) => e.type === 'session/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data['reason']).toBe('interrupted')
    store2.close()
  })

  it('正常收尾的 session 不补 closers', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!;
    const sid = store.createSession('书A')
    store.appendEvent(sid, { type: 'session/start', data: {} })
    store.appendEvent(sid, { type: 'session/end', data: { reason: 'completed' } })
    store.close()
    const store2 = openSessionStore(ud, '/books/a')!;
    expect(store2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    store2.close()
  })
})

