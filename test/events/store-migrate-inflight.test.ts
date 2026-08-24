/**
 * N8（五十九轮）回归：migrateBookSession 强制关库前断言在途引用。
 *
 * 「先中止会话」此前只是调用方纪律（无程序性保障）——refs>1（仍有 openSessionStore
 * 未 close 的使用方）时强关会把在途写入打到已关句柄上。验证：有在途引用 → 迁移
 * 放弃（false，源库原地完整）；引用收口后 → 迁移成功。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { openSessionStore, migrateBookSession, bookHash } from '../../src/events/store.js'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'n8-migrate-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('N8 migrateBookSession 在途引用断言', () => {
  it('refs>1（在途引用）→ 迁移放弃 false 且源库原地保留；收口后迁移成功', () => {
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

    // 在途引用未收口 → N8 断言拦下：放弃迁移，源库原地完整
    const r1 = migrateBookSession(ud, oldRoot, newRoot, '旧书名', '新书名')
    expect(r1).toBe(false)
    expect(existsSync(oldDb)).toBe(true)
    expect(existsSync(newDb)).toBe(false)
    // 在途引用仍可用（未被强关）
    s2.appendEvent(sid, { type: 'llm/call', data: { task: 't2', ok: true } })

    // 收口一个引用后（refs=1 → 强制关库只影响自身）→ 迁移成功
    s2.close()
    const r2 = migrateBookSession(ud, oldRoot, newRoot, '旧书名', '新书名')
    expect(r2).toBe(true)
    expect(existsSync(oldDb)).toBe(false)
    expect(existsSync(newDb)).toBe(true)

    // 旧句柄已随强关失效（引用计数归零真关），s1.close 幂等不再动库文件
    s1.close()
    expect(existsSync(newDb)).toBe(true)
  })
})
