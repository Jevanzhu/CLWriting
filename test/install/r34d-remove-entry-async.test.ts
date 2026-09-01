/**
 * 残留清偿批（三十四轮）回归：removeBookEntryAsync（删书端点异步孪生）。
 * 语义与同步版逐位对齐：锁内 RMW 过滤、活动书指针清理、超时跳过留痕（登记不动）。
 * 锁超时注入走 __setBooksLockTimeoutForTest（生产零调用钩子）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  readBooks,
  writeBooks,
  writeActive,
  readActive,
  tryBooksLock,
  removeBookEntryAsync,
  __setBooksLockTimeoutForTest,
} from '../../src/install/books.js'

let workDir = ''

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'r34d-rem-'))
  writeBooks(workDir, [
    { name: '书A', path: '好/书A', kind: 'short' },
    { name: '书B', path: '好/书B', kind: 'short' },
  ])
})
afterEach(() => {
  __setBooksLockTimeoutForTest(5_000)
  rmSync(workDir, { recursive: true, force: true })
})

describe('removeBookEntryAsync（残留清偿：mutator 族服务面归零后的端点孪生）', () => {
  it('删活动书：登记过滤 + active 指针清空', async () => {
    writeActive(workDir, '书A')
    await removeBookEntryAsync(workDir, '书A')
    expect(readBooks(workDir).map((b) => b.name)).toEqual(['书B'])
    expect(readActive(workDir)).toBeNull() // 写空串 → readActive 归一化为 null
  })

  it('删非活动书：active 不动', async () => {
    writeActive(workDir, '书A')
    await removeBookEntryAsync(workDir, '书B')
    expect(readBooks(workDir).map((b) => b.name)).toEqual(['书A'])
    expect(readActive(workDir)).toBe('书A')
  })

  it('锁被他方持有（同进程占位模拟双进程争用）→ 超时跳过留痕，登记原样', async () => {
    __setBooksLockTimeoutForTest(150)
    const release = tryBooksLock(workDir) // 同进程持锁：pid 存活探测恒活 → 异步获取必超时
    expect(release).not.toBeNull()
    try {
      await removeBookEntryAsync(workDir, '书A')
    } finally {
      release!()
    }
    expect(readBooks(workDir).map((b) => b.name)).toEqual(['书A', '书B'])
  })
})
