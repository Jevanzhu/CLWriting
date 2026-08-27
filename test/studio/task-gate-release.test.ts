/**
 * R66-29（十四轮）回归：task-gate release() 的 rmSync 失败不得永久占死进程内闸。
 *
 * 缺陷：release 里 rmSync(lockPath, {force:true}) 的 force 仅吞 ENOENT——EPERM 等
 * 失败裸抛会跳过 running.delete(key)，该闸在本进程内永久占死（后续同 key 全 409）。
 * 修复：包 try/catch 保证 running.delete 必达；锁文件残留由 stale 接管清理兜底。
 *
 * 测法：vi.mock('node:fs'）仅覆盖 rmSync 恒抛 EPERM（其余原样）——acquire 路径
 * （open 'wx' 写锁）不受影响，release 必抛。断言：release 不抛 + 闸已释放 + 可再占
 * + 锁文件确有残留（证明 EPERM 真实发生，用例未退化成普通释放）。
 */
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    // R66-29：仅覆盖 rmSync——force 不吞的 EPERM 形态（Windows 只读属性/杀软锁定同族）
    rmSync: () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    },
  }
})

import { acquireTaskGate, isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'

let lockDir = ''
const BOOK = 'R66-29 测试书'
const ACTION = 'analyze'
const lockPath = (action: string, book: string): string =>
  join(lockDir, `${createHash('sha256').update(`${action}\u0000${book}`).digest('hex').slice(0, 16)}.lock`)

beforeAll(() => {
  lockDir = mkdtempSync(join(tmpdir(), 'clwriting-r66-29-'))
})

afterAll(async () => {
  // rmSync 已被 mock 抛错——用未被 mock 的 node:fs/promises（不同 specifier）清理临时目录
  const { rm } = await import('node:fs/promises')
  await rm(lockDir, { recursive: true, force: true })
})

it('release 时 rmSync 抛 EPERM：不抛出、进程内闸照常释放、其他闸不受牵连；锁文件残留由 stale 接管兜底', () => {
  const r = acquireTaskGate(BOOK, ACTION, { lockDir })
  expect(r).not.toBeNull()
  expect(isTaskGateHeld(BOOK, ACTION)).toBe(true)
  const p = lockPath(ACTION, BOOK)
  expect(existsSync(p)).toBe(true)

  // 修复前：EPERM 从 release 裸抛，running.delete 被跳过 → 进程内闸永久占死
  expect(() => r!()).not.toThrow()
  expect(isTaskGateHeld(BOOK, ACTION)).toBe(false)

  // EPERM 真实发生：锁文件未被删除（此断言同时防止用例退化成「rmSync 正常成功」）。
  // 残留锁文件含本进程 pid（存活）→ 同 key 再占会被跨进程锁保守拒 null——这是
  // cross-process-lock 的既定保守面（活 pid + 锁文件 = 可能在跑），非本条缺陷；
  // 进程退出后由 stale 接管清理恢复。此处断言的是进程内不泄漏：
  expect(acquireTaskGate(BOOK, ACTION, { lockDir })).toBeNull() // 跨进程保守拒（残留文件）
  expect(isTaskGateHeld(BOOK, ACTION)).toBe(false) // 但进程内 Set 已清——不永占

  // 其他 key（同书不同 action）不受牵连——running 的清理没有误伤邻居
  const other = acquireTaskGate(BOOK, 'rewrite', { lockDir })
  expect(other).not.toBeNull()
  expect(() => other!()).not.toThrow()
  expect(isTaskGateHeld(BOOK, 'rewrite')).toBe(false)
})
