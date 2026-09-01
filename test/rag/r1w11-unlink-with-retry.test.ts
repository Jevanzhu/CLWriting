/**
 * R1W-11（win 平台专项复审 R1）：deleteRagDbFiles unlink 退避单测。
 *
 * 契约：① 注入 unlink 撞 EBUSY/EPERM → 3×50ms 指数退避重试救回；
 * ② 持续占用 → 重试耗尽后原样上抛（调用方按失败收口，不静默吞）；
 * ③ 确定性错误（ENOENT）→ 立即抛零退避；
 * ④ 真 fs 冒烟——deleteRagDbFiles 开库→关库→删除后 ragDbExists 翻假。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteRagDbFiles, openRagDb, ragDbExists, unlinkWithRetry } from '../../src/rag/store.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

describe('unlinkWithRetry（R1W-11）', () => {
  it('瞬时 EBUSY（第 3 次成功）→ 重试救回，退避 50/100ms', () => {
    const delays: number[] = []
    let calls = 0
    unlinkWithRetry('rag.db', {
      unlink: () => {
        if (++calls <= 2) throw errOf('EBUSY')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(3)
    expect(delays).toEqual([50, 100])
  })

  it('瞬时 EPERM（第 2 次成功）→ 重试救回', () => {
    const delays: number[] = []
    let calls = 0
    unlinkWithRetry('rag.db', {
      unlink: () => {
        if (++calls === 1) throw errOf('EPERM')
      },
      sleep: (ms) => delays.push(ms),
    })
    expect(calls).toBe(2)
    expect(delays).toEqual([50])
  })

  it('持续 EBUSY → 1+3 次尝试后原样上抛（不静默吞）', () => {
    let calls = 0
    expect(() =>
      unlinkWithRetry('rag.db', {
        unlink: () => {
          calls++
          throw errOf('EBUSY')
        },
        sleep: () => {},
      }),
    ).toThrow('mock EBUSY')
    expect(calls).toBe(4)
  })

  it('确定性错误（ENOENT）→ 立即抛，零退避', () => {
    const delays: number[] = []
    let calls = 0
    expect(() =>
      unlinkWithRetry('rag.db', {
        unlink: () => {
          calls++
          throw errOf('ENOENT')
        },
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow('mock ENOENT')
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })
})

describe('deleteRagDbFiles 真 fs 冒烟（R1W-11 接线不变性）', () => {
  it('开库→关库→删除 → rag.db 与侧车全部清空', () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-r1w11-rag-'))
    try {
      const db = openRagDb(root)
      db.close()
      expect(ragDbExists(root)).toBe(true)
      expect(existsSync(join(root, '.cache', 'rag.db'))).toBe(true)
      deleteRagDbFiles(root)
      expect(existsSync(join(root, '.cache', 'rag.db'))).toBe(false)
      expect(existsSync(join(root, '.cache', 'rag.db-wal'))).toBe(false)
      expect(existsSync(join(root, '.cache', 'rag.db-shm'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('不存在库 → 逐后缀 existsSync 短路，不抛', () => {
    const root = mkdtempSync(join(tmpdir(), 'clw-r1w11-rag-'))
    try {
      writeFileSync(join(root, '占位'), 'x')
      expect(() => deleteRagDbFiles(root)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
