/**
 * R37-39（三十七轮批 A）回归——deleteRagDbFiles 的 unlink EBUSY/EPERM/EACCES 退避重试。
 *
 * 缺陷：rag.db 损坏自愈 rebuild 前的删库链（resetRagIndex → deleteRagDbFiles）用裸
 * unlinkSync——Windows 上杀毒/索引器瞬时占用 .cache/rag.db 时撞 EBUSY/EPERM，无退避
 * 直接把删库自愈变 500。修复：瞬时占用码重试至多 3 次 × 200ms（同步退避，先例同
 * fs/atomic.ts renameWithRetry：Atomics.wait 微睡 + unlink/sleep 可注入测试口）；
 * 耗尽抛带结构化信息的错误（文件名+code+已重试次数），损坏判定面不受污染。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteRagDbFiles, isRagDbCorruptionError } from '../../src/rag/store.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const errOf = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`mock ${code}`), { code })

/** 造一本带 rag.db + 侧车残留的书目录，返回书根 */
function makeBook(): string {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'clw-r37-del-'))
  mkdirSync(join(bookRoot, '.cache'), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) {
    writeFileSync(join(bookRoot, '.cache', `rag.db${suffix}`), 'bytes', 'utf8')
  }
  return bookRoot
}

describe('deleteRagDbFiles unlink 退避重试（R37-39）', () => {
  it('瞬时 EBUSY（前两次抛、第三次成功）→ 删除成功，退避 200ms×2，三文件全清', () => {
    const bookRoot = makeBook()
    try {
      const delays: number[] = []
      // 只对主库文件注入瞬时占用（endsWith('rag.db') 不匹配 -wal/-shm 侧车）
      const calls: string[] = []
      expect(() =>
        deleteRagDbFiles(bookRoot, {
          unlink: (fp) => {
            if (fp.endsWith('rag.db')) {
              calls.push(fp)
              if (calls.length <= 2) throw errOf('EBUSY')
            }
            unlinkSync(fp) // 占用注入后的那次（及侧车文件）真实删除
          },
          sleep: (ms) => delays.push(ms),
        }),
      ).not.toThrow()
      expect(calls).toHaveLength(3) // 主库文件 1 次初始 + 2 次重试后成功
      expect(delays).toEqual([200, 200])
      for (const suffix of ['', '-wal', '-shm']) {
        expect(existsSync(join(bookRoot, '.cache', `rag.db${suffix}`))).toBe(false)
      }
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('持续 EPERM → 1+3 次后抛结构化错误（含文件名/code/已重试次数），不落损坏判定面', () => {
    const bookRoot = makeBook()
    try {
      const delays: number[] = []
      let calls = 0
      let thrown: Error | null = null
      try {
        deleteRagDbFiles(bookRoot, {
          unlink: () => {
            calls++
            throw errOf('EPERM')
          },
          sleep: (ms) => delays.push(ms),
        })
      } catch (e) {
        thrown = e as Error
      }
      expect(thrown).not.toBeNull()
      expect(calls).toBe(4) // 1 次初始 + 3 次重试
      expect(delays).toEqual([200, 200, 200])
      const msg = thrown!.message
      expect(msg).toContain('rag.db') // 文件名
      expect(msg).toContain('EPERM') // code
      expect(msg).toContain('已重试 3') // 已重试次数
      // 上层 isRagDbCorruptionError/rebuild 自愈语义不变：该错误绝不被误判为损坏
      expect(isRagDbCorruptionError(thrown)).toBe(false)
      // 失败后文件仍在（未被半删）
      expect(existsSync(join(bookRoot, '.cache', 'rag.db'))).toBe(true)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('非重试码（EACCES 之外的确定性错误 ENOENT）→ 立即原样抛，零退避零重试', () => {
    const bookRoot = makeBook()
    try {
      const delays: number[] = []
      let calls = 0
      expect(() =>
        deleteRagDbFiles(bookRoot, {
          unlink: () => {
            calls++
            throw errOf('ENOENT')
          },
          sleep: (ms) => delays.push(ms),
        }),
      ).toThrow('mock ENOENT')
      expect(calls).toBe(1)
      expect(delays).toEqual([])
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('EACCES 也在重试面（win FAT 权限变体）；第 2 次成功 → 救回', () => {
    const bookRoot = makeBook()
    try {
      const delays: number[] = []
      let calls = 0
      expect(() =>
        deleteRagDbFiles(bookRoot, {
          unlink: (fp) => {
            if (++calls === 1) throw errOf('EACCES')
            unlinkSync(fp)
          },
          sleep: (ms) => delays.push(ms),
        }),
      ).not.toThrow()
      expect(calls).toBeGreaterThanOrEqual(2)
      expect(delays).toEqual([200])
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('默认接线（真 unlinkSync）冒烟：三个库文件一次删净', () => {
    const bookRoot = makeBook()
    try {
      deleteRagDbFiles(bookRoot)
      for (const suffix of ['', '-wal', '-shm']) {
        expect(existsSync(join(bookRoot, '.cache', `rag.db${suffix}`))).toBe(false)
      }
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})
