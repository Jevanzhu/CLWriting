/**
 * Y-P1-1 / Y-P2-6 / Y-P2-7 回归锚：连接单例（引用计数）、活跃会话跳过孤儿修复、
 * clearChatHistory 双钥匙清库。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { SessionRecorder, sessionStartEvent } from '../../src/events/chat-bridge.js'
import { clearChatHistory } from '../../src/ai/orchestrate/chat.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'y-store-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Y-P2-6 连接单例（引用计数）', () => {
  it('同路径重复 open 复用同一连接（写读互通）', () => {
    const ud = tmpRoot()
    const s1 = openSessionStore(ud, '/books/a')!
    const sid = s1.createSession('书A')
    s1.appendEvent(sid, { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' })
    const s2 = openSessionStore(ud, '/books/a')!
    expect(s2.lastSeq()).toBe(1)
    s2.appendEvent(sid, { type: 'user/message', data: { message: 'y' }, surfaceOp: 'append' })
    expect(s1.listEvents('书A')).toHaveLength(2)
    s1.close()
    s2.close()
  })

  it('引用计数：一引用释放后其余引用仍可用；全部释放重开才触发修复（真关库）', () => {
    const ud = tmpRoot()
    const s1 = openSessionStore(ud, '/books/a')!
    const s2 = openSessionStore(ud, '/books/a')!
    s1.close()
    // 模拟 steer 续链：旧引用已释放，新引用继续写
    const sid = s2.createSession('书A')
    s2.appendEvent(sid, { type: 'session/start', data: {} })
    s2.close()
    const s3 = openSessionStore(ud, '/books/a')!
    expect(s3.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    s3.close()
  })

  it('close 幂等：重复 close 与旧引用后关均不误伤新开', () => {
    const ud = tmpRoot()
    const s1 = openSessionStore(ud, '/books/a')!
    s1.close()
    s1.close()
    const s2 = openSessionStore(ud, '/books/a')!
    const sid = s2.createSession('书A')
    s2.appendEvent(sid, { type: 'user/message', data: { message: 'z' }, surfaceOp: 'append' })
    s1.close()
    expect(s2.listEvents('书A')).toHaveLength(1)
    s2.close()
  })
})

describe('Y-P1-1 活跃会话跳过孤儿修复', () => {
  it('进行中会话：重开库不注入 session/end；dispose 后重开才补', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    const r = new SessionRecorder(store, sid)
    r.add(sessionStartEvent('书A'))
    r.flush()
    store.close()
    // 模拟活跃会话期间另一路径重开库（此前会注入虚假 session/end{interrupted}）
    const s2 = openSessionStore(ud, '/books/a')!
    expect(s2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(0)
    s2.close()
    r.dispose()
    const s3 = openSessionStore(ud, '/books/a')!
    expect(s3.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    expect(s3.listEvents('书A').filter((e) => e.type === 'session/end')[0]!.data['reason']).toBe('interrupted')
    s3.close()
  })

  it('SessionRecorder.close 幂等：两次 close 只写一个 session/end', () => {
    const ud = tmpRoot()
    const store = openSessionStore(ud, '/books/a')!
    const sid = store.createSession('书A')
    const r = new SessionRecorder(store, sid)
    r.add(sessionStartEvent('书A'))
    r.close('completed')
    r.close('completed')
    r.dispose()
    store.close()
    const s2 = openSessionStore(ud, '/books/a')!
    expect(s2.listEvents('书A').filter((e) => e.type === 'session/end')).toHaveLength(1)
    s2.close()
  })
})

describe('Y-P2-7 clearChatHistory 双钥匙清库', () => {
  it('对话会话（bookName）与 workspace 会话（bookHash）都清', () => {
    const ud = tmpRoot()
    const bookRoot = '/books/a'
    const store = openSessionStore(ud, bookRoot)!
    const chatSid = store.createSession('书A')
    store.appendEvent(chatSid, { type: 'user/message', data: { message: 'm' }, surfaceOp: 'append' })
    const wsSid = store.workspaceSession(bookHash(bookRoot))
    store.appendEvent(wsSid, { type: 'llm/call', data: { task: 'chat' } })
    store.close()
    clearChatHistory('书A', ud, bookRoot)
    const s2 = openSessionStore(ud, bookRoot)!
    expect(s2.listEvents('书A')).toHaveLength(0)
    expect(s2.listEvents(bookHash(bookRoot))).toHaveLength(0)
    s2.close()
  })
})
