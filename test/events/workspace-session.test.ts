/**
 * F1-P2 workspace 会话单测：每书一个 ws 会话承载链路事件，惰性创建复用，
 * 且不干扰对话恢复（latestSession 排除 ws）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'f1-ws-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('F1-P2 workspaceSession', () => {
  it('惰性创建且复用——多次调用返回同一 session_id（ws- 前缀）', () => {
    const ud = tmpRoot()
    const book = bookHash('/books/a')
    const store = openSessionStore(ud, '/books/a')!
    try {
      const s1 = store.workspaceSession(book)
      const s2 = store.workspaceSession(book)
      expect(s1).toMatch(/^ws-/)
      expect(s2).toBe(s1)
    } finally {
      store.close()
    }
  })

  it('不同书各自独立 ws 会话', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    try {
      const a = store.workspaceSession(bookHash('/books/a'))
      const b = store.workspaceSession(bookHash('/books/b'))
      expect(a).not.toBe(b)
      // 同一库内两本书事件互不串（listEvents 按 book 过滤）
      store.appendEvent(a, { type: 'llm/call', data: { task: 't', ok: true } })
      expect(store.listEvents(bookHash('/books/a'))).toHaveLength(1)
      expect(store.listEvents(bookHash('/books/b'))).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('链路事件挂 ws 会话可被 listEvents(book) 读到（重放/审计用）', () => {
    const ud = tmpRoot()
    const book = bookHash('/books/a')
    const store = openSessionStore(ud, '/books/a')!
    try {
      const sid = store.workspaceSession(book)
      store.appendEvent(sid, { type: 'step/start', data: { task: 'chat', layer: 'chat' } })
      store.appendEvent(sid, { type: 'llm/call', data: { task: 'chat', ok: true } })
      const evs = store.listEvents(book)
      expect(evs.map((e) => e.type)).toEqual(['step/start', 'llm/call'])
    } finally {
      store.close()
    }
  })

  it('latestSession 排除 ws 会话——对话恢复不受链路事件干扰', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    try {
      const book = bookHash('/books/a')
      const sid = store.workspaceSession(book)
      store.appendEvent(sid, { type: 'llm/call', data: { task: 't', ok: true } })
      // ws 会话是最新更新的，但 latestSession 必须排除它
      expect(store.latestSession(book)).toBeNull()
      // 建一个真实对话会话后，latestSession 返回它（不是 ws）
      const chatSid = store.createSession('书A', { book: '书A' })
      store.appendEvent(chatSid, { type: 'user/message', data: { message: 'hi' }, surfaceOp: 'append' })
      const latest = store.latestSession('书A')
      expect(latest?.session_id).toBe(chatSid)
      // 此时再写 ws 事件（更新时间更晚），latestSession 仍返回对话会话
      store.appendEvent(sid, { type: 'llm/retry', data: { attempt: 0, delayMs: 10 } })
      expect(store.latestSession('书A')?.session_id).toBe(chatSid)
    } finally {
      store.close()
    }
  })
})

