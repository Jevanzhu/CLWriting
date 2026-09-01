/**
 * N8（五十九轮）回归：migrateBookSession 强制关库前断言在途引用。
 *
 * 「先中止会话」此前只是调用方纪律（无程序性保障）——仍有 openSessionStore 未
 * close 的使用方时强关会把在途写入打到已关句柄上。R64-8（十二轮）：判定从
 * refs>1 收紧为 refs>0——refs==1（首个在途调用方）同样是活跃持有者。验证：
 * refs≥1 → 迁移放弃（false，源库原地完整）；全部收口（refs=0）→ 迁移成功。
 */
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { openSessionStore, migrateBookSession, bookHash } from '../../src/events/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempTracked(join(tmpdir(), 'n8-migrate-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('N8 migrateBookSession 在途引用断言', () => {
  it('refs>0（在途引用，含 refs==1）→ 迁移放弃 false 且源库原地保留；全部收口后迁移成功', async () => {
    const ud = tmpRoot()
    const oldRoot = '/books/n8-a'
    const newRoot = '/books/n8-b'
    const sessionDir = join(ud, 'clwriting', 'session')
    const oldDb = join(sessionDir, bookHash(oldRoot) + '.db')
    const newDb = join(sessionDir, bookHash(newRoot) + '.db')

    // 双开（同进程单例引用计数 → refs=2，模拟在途对话/自愈仍握连接）
    const s1 = openSessionStore(ud, oldRoot)!
    const s2 = openSessionStore(ud, oldRoot)!
    const sid = s1.createSession('旧书名')
    s1.appendEvent(sid, { type: 'llm/call', data: { task: 't', ok: true } })
    expect(existsSync(oldDb)).toBe(true)

    // refs=2（双开在途）→ N8 断言拦下：放弃迁移，源库原地完整
    const r1 = await migrateBookSession(ud, oldRoot, newRoot, '旧书名', '新书名')
    expect(r1).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)
    // 在途引用仍可用（未被强关）
    s2.appendEvent(sid, { type: 'llm/call', data: { task: 't2', ok: true } })

    // 收口一个引用后 refs=1 → R64-8：首个在途调用方同样是活跃持有者，仍拦
    s2.close()
    const r2 = await migrateBookSession(ud, oldRoot, newRoot, '旧书名', '新书名')
    expect(r2).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)

    // 全部收口（refs=0 真关+清缓存）→ 迁移成功
    s1.close()
    const r3 = await migrateBookSession(ud, oldRoot, newRoot, '旧书名', '新书名')
    expect(r3).toBe(true)
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)
  })
})
