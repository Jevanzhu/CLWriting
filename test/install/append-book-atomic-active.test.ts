/**
 * 0918二轮修复批（G104）：appendBook「登记 + active 指针」同临界段（books.lock 内）回归。
 *
 * 修前：appendBook/appendBookAsync 持锁只写 books.jsonl，writeActive 由 doInit/
 * doInitAsync 在锁外裸写——双进程并发建书时两个「登记→切指针」段交错，active 被
 * 先释放锁的一方事后覆盖（最后写者胜，指针指向非最后完成的书）。修后：active 写
 * 收编进 appendBookLocked（失败语义沿 R44-18 原口径：登记在、active 未写、reason
 * 可行动）。本文件锁三点：① appendBook 成功即 active 已写（对旧实现红——旧实现
 * 只登记不切指针）；② active 写失败信封；③ 并发建书终态一致。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 注入开关：默认透传真实 IO；置位时对 .clwriting/active 的原子写抛 EACCES
// （writeActive 已收编进 appendBookLocked 内部词法调用，失败注入面在 atomic 层）
const gate = vi.hoisted(() => ({ activeWriteThrows: false }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...mod,
    atomicWriteFile: (
      filePath: string,
      data: string | Uint8Array,
      opts?: Parameters<typeof mod.atomicWriteFile>[2],
    ) => {
      if (gate.activeWriteThrows && String(filePath).endsWith('active')) {
        const e = new Error('EACCES: permission denied, open active') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return mod.atomicWriteFile(filePath, data, opts)
    },
  }
})

import { appendBook, appendBookAsync, readActive, readBooks } from '../../src/install/books.js'
import { doInitAsync } from '../../src/install/init.js'

afterEach(() => {
  gate.activeWriteThrows = false
  vi.restoreAllMocks()
})

describe('appendBook：登记 + active 同临界段', () => {
  it('appendBook 成功 → active 指针随登记原子写就（旧实现只登记不切 active，本断言对其红）', () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-append-active-sync-'))
    const r = appendBook(wd, { name: '同步书', path: '长篇/同步书', kind: 'long' })
    expect(r.ok).toBe(true)
    expect(readActive(wd)).toBe('同步书')
    expect(readBooks(wd)).toHaveLength(1)
  })

  it('appendBookAsync（异步孪生）同源：成功即 active 在位', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-append-active-async-'))
    const r = await appendBookAsync(wd, { name: '异步书', path: '长篇/异步书', kind: 'long' })
    expect(r.ok).toBe(true)
    expect(readActive(wd)).toBe('异步书')
  })

  it('active 写失败 → {ok:false} reason 明示登记已成功可手动启用；登记在盘、active 未写', () => {
    gate.activeWriteThrows = true
    const wd = mkdtempTracked(join(tmpdir(), 'clw-append-active-fail-'))
    const r = appendBook(wd, { name: '指针失败书', path: '长篇/指针失败书', kind: 'long' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('已建成并登记成功')
      expect(r.reason).toContain('活动书')
      expect(r.reason).toContain('无需重建')
    }
    expect(readBooks(wd).some((b) => b.name === '指针失败书')).toBe(true) // 登记已落盘
    expect(readActive(wd)).toBeNull() // 指针未写
  })

  it('并发两路 doInitAsync 交错建书 → 双双登记成功，active 终态指向其中一本（锁内原子，无锁外覆盖窗）', async () => {
    const wd = mkdtempTracked(join(tmpdir(), 'clw-append-active-race-'))
    const [ra, rb] = await Promise.all([
      doInitAsync({ workDir: wd, name: '竞赛甲', genre: '玄幻' }),
      doInitAsync({ workDir: wd, name: '竞赛乙', genre: '科幻' }),
    ])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    const names = readBooks(wd)
      .map((b) => b.name)
      .sort((a, b) => a.localeCompare(b, 'zh'))
    expect(names).toEqual(['竞赛甲', '竞赛乙'])
    // active 必指向最后完成持锁段的那本（两候选之一；锁内写保证不出现锁外事后覆盖）
    const active = readActive(wd)
    expect(['竞赛甲', '竞赛乙']).toContain(active)
  })
})
