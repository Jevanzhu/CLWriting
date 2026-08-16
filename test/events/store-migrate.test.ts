/**
 * 改书事件库迁移单测：migrateBookSession 把旧 hash DB → 新 hash DB，
 * 并把会话 book 字段改名（对话 book=旧名 → 新名、工作区 book=旧 hash → 新 hash）。
 * 尽力而为语义：失败/无库 no-op 不抛。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, migrateBookSession, bookHash } from '../../src/events/store.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'f1-migrate-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('migrateBookSession', () => {
  it('迁移后新名可读到原会话（对话 + 工作区），旧库文件被移走', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/旧名'
    const newRoot = '/books/新名'
    const oldDb = join(ud, 'clwriting', 'session', bookHash(oldRoot) + '.db')
    const newDb = join(ud, 'clwriting', 'session', bookHash(newRoot) + '.db')

    // 造数据：对话会话 book=旧名 + 工作区会话 book=bookHash(oldRoot)
    const store = openSessionStore(ud, oldRoot)!
    const chatSid = store.createSession('旧名')
    store.appendEvents(chatSid, [{ type: 'user/message', data: { message: '你好' }, surfaceOp: 'append' }])
    const wsSid = store.createSession(bookHash(oldRoot))
    store.appendEvents(wsSid, [{ type: 'step/start', data: {} }])
    store.close()
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)

    migrateBookSession(ud, oldRoot, newRoot, '旧名', '新名')

    // 旧库文件已移走、新库文件出现
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)
    // 新名可读到迁移后的对话 + 工作区会话
    const migrated = openSessionStore(ud, newRoot)!
    const chatEvs = migrated.listEvents('新名')
    expect(chatEvs.map((e) => e.type)).toContain('user/message')
    expect(migrated.listEvents(bookHash(newRoot)).length).toBeGreaterThan(0)
    // 旧名/旧 hash 查不到（book 字段已改）
    expect(migrated.listEvents('旧名')).toEqual([])
    expect(migrated.listEvents(bookHash(oldRoot))).toEqual([])
    migrated.close()
  })

  it('userDataPath 为空 → no-op；旧库不存在 → no-op（不抛）', () => {
    const ud = tmpRoot()
    expect(() => migrateBookSession(null, '/books/a', '/books/b', 'a', 'b')).not.toThrow()
    expect(() => migrateBookSession(ud, '/books/a', '/books/b', 'a', 'b')).not.toThrow()
    // 没建过库 → 无新库文件产生
    expect(existsSync(join(ud, 'clwriting', 'session', bookHash('/books/b') + '.db'))).toBe(false)
  })

  it('旧库缓存连接未关闭时也能强制迁移（引用计数被清零）', () => {
    const ud = tmpRoot()
    const oldRoot = '/books/甲'
    const newRoot = '/books/乙'
    // 不 close：模拟仍有引用在手的场景
    const store = openSessionStore(ud, oldRoot)!
    const sid = store.createSession('甲')
    store.appendEvents(sid, [{ type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' }])

    migrateBookSession(ud, oldRoot, newRoot, '甲', '乙')

    const migrated = openSessionStore(ud, newRoot)!
    expect(migrated.listEvents('乙').length).toBeGreaterThan(0)
    migrated.close()
    // 旧连接对象继续 close 不应抛（幂等）
    expect(() => store.close()).not.toThrow()
  })
})
