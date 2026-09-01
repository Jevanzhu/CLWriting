/**
 * R34D-19（三十四轮）回归：openSessionStoreAsync 异步开库孪生。
 *
 * 锁纪律收口后的行为契约：
 * 1) 语义与同步壳对齐——首开建库/DDL/登记缓存，createSession/appendEvent/listEvents
 *    全链可用；
 * 2) 缓存命中免锁直复用（引用计数与同步壳一致，写读互通）；
 * 3) 同步/异步两壳共享同一缓存（混用不双开）；
 * 4) 并发首开（等待窗内双检路径）不重复建库、不抛错；
 * 5) migrateBookSession 转 async 后契约不变（fresh 书 no-op 迁移 true）。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionStore, openSessionStoreAsync, migrateBookSession, bookHash } from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'r34d-async-open-'))
  dirs.push(d)
  return d
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('R34D-19 openSessionStoreAsync 异步开库孪生', () => {
  it('首开建库全链可用（createSession → appendEvent → listEvents）', async () => {
    const ud = tmpRoot()
    const s = await openSessionStoreAsync(ud, '/books/async-a')
    expect(s).not.toBeNull()
    const sid = s!.createSession('书A')
    s!.appendEvent(sid, { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' })
    expect(s!.lastSeq()).toBe(1)
    expect(s!.listEvents('书A')).toHaveLength(1)
    s!.close()
  })

  it('缓存命中复用同一连接（引用计数，写读互通）', async () => {
    const ud = tmpRoot()
    const s1 = await openSessionStoreAsync(ud, '/books/async-b')
    const sid = s1!.createSession('书B')
    s1!.appendEvent(sid, { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' })
    const s2 = await openSessionStoreAsync(ud, '/books/async-b')
    expect(s2!.dbPath).toBe(s1!.dbPath)
    expect(s2!.lastSeq()).toBe(1)
    s1!.close()
    s2!.close()
  })

  it('同步/异步两壳共享缓存（混用不双开）', async () => {
    const ud = tmpRoot()
    const sync = openSessionStore(ud, '/books/mixed')!
    const sid = sync.createSession('书C')
    sync.appendEvent(sid, { type: 'user/message', data: { message: 'x' }, surfaceOp: 'append' })
    const async = await openSessionStoreAsync(ud, '/books/mixed')
    expect(async!.dbPath).toBe(sync.dbPath)
    // 异步壳在已登记缓存上取引用（refs++），事件互通
    expect(async!.lastSeq()).toBe(1)
    sync.close()
    async!.close()
  })

  it('并发首开（双检路径）→ 同一库、零抛错', async () => {
    const ud = tmpRoot()
    const [a, b] = await Promise.all([
      openSessionStoreAsync(ud, '/books/race'),
      openSessionStoreAsync(ud, '/books/race'),
    ])
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(a!.dbPath).toBe(b!.dbPath)
    expect(a!.dbPath.endsWith(bookHash('/books/race') + '.db')).toBe(true)
    a!.close()
    b!.close()
  })

  it('migrateBookSession（async 化后契约不变）：fresh 书 no-op 迁移 true', async () => {
    const ud = tmpRoot()
    const r = await migrateBookSession(ud, '/books/old', '/books/new', '旧名', '新名')
    expect(r).toBe(true)
  })
})
