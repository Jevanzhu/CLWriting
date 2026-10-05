/**
 * fs/file-identity：同物理文件判定的 bigint 精确口径回归。
 *
 * 靶：ino 判等必须走 `{ bigint: true }` 形态——NTFS File ID 是 64 位，缺省
 * `statSync().ino` 是 Number（IEEE double 53 位尾数），超 2^53 后低位塌缩，两个不同
 * 文件得到同值；判定若回退为缺省形态，「目标位已被占」会被误判成「纯大小写变体
 * （同一物理文件）」而放行 REPLACE 覆盖（章纲同步「目标名被占」用例的红线形态：
 * link 独占探测已拦下 EEXIST、同物理复核又放行）。本档 mock statSync：number 形态
 * 按真实塌缩行为返回同值、bigint 形态返回两个不同 ID——判定回退到 Number 形态即红。
 * 消费面（samePhysicalPath 回落链）同档锚定。实现与证据见 src/fs/file-identity.ts
 * 头注。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const M = vi.hoisted(() => ({ failStat: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  // 模拟 win NTFS：两枚 File ID 差 2（2^56 量级），Number 形态塌缩为同值
  const INO_A = 91197892454771137n
  const INO_B = 91197892454771139n
  const NUMBER_COLLAPSED = Number(INO_A) // === Number(INO_B)
  const statSync = ((p: string, opts?: { bigint?: boolean }) => {
    if (M.failStat) throw Object.assign(new Error('mock ENOENT'), { code: 'ENOENT' })
    if (opts?.bigint === true) return { dev: 7n, ino: String(p).endsWith('b') ? INO_B : INO_A }
    return { dev: 7, ino: NUMBER_COLLAPSED }
  }) as unknown as typeof actual.statSync
  return { ...actual, statSync }
})

import { isSamePhysicalFile, samePhysicalFileExact } from '../../src/fs/file-identity.js'
import { samePhysicalPath } from '../../src/fs/user-data-path.js'

beforeEach(() => {
  M.failStat = false
})

describe('isSamePhysicalFile：bigint 精确判定（Number 塌缩防假阳性）', () => {
  it('前置：mock 复刻的真实塌缩——两文件 Number(ino) 相等、bigint 不等', () => {
    expect(Number(91197892454771137n)).toBe(Number(91197892454771139n))
    expect(91197892454771137n).not.toBe(91197892454771139n)
  })

  it('塌缩对：number 形态同值 / bigint 形态不同 → false（回退 Number 形态即红）', () => {
    expect(isSamePhysicalFile('/libs/a', '/libs/b')).toBe(false)
  })

  it('真同一（同路径）：true（防「恒 false」实现假绿）', () => {
    expect(isSamePhysicalFile('/libs/a', '/libs/a')).toBe(true)
  })

  it('stat 失败：isSamePhysicalFile 保守 false / samePhysicalFileExact 原样上抛', () => {
    M.failStat = true
    expect(isSamePhysicalFile('/libs/a', '/libs/b')).toBe(false)
    expect(() => samePhysicalFileExact('/libs/a', '/libs/b')).toThrow()
  })
})

describe('samePhysicalPath（user-data-path 消费面）', () => {
  it('塌缩对 → false（物理判等走同一 bigint 单源）', () => {
    expect(samePhysicalPath('/libs/a', '/libs/b')).toBe(false)
  })

  it('stat 失败回落 samePath 字符串口径（同串 → true）', () => {
    M.failStat = true
    expect(samePhysicalPath('/libs/same', '/libs/same')).toBe(true)
  })
})
