/**
 * R0910-W（2026-09-10 修复批）回归：tryIncrementalRebuild 只读句柄泄漏。
 *
 * 增量探测只读打开 index.db 成功、随后首个 exec 抛错（库损坏/被锁）时，原实现直接
 * return null 未关句柄——win 上泄漏 fd 使「删 .cache/index.db 重试」自愈撞 EBUSY/EPERM
 * （全量路径 R65-22 已修，增量路径漏了同款）。本用例注入假 DatabaseSync：构造成功、
 * exec 抛错，断言只读实例的 close() 被调用恰一次（回归此修复）。
 */
import { test, expect, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// vi.mock 工厂提升到文件顶部，运行时状态须经 vi.hoisted 传递（库内既定形态）
const mocks = vi.hoisted(() => ({ readOnlyCloseCalls: 0 }))

vi.mock('node:sqlite', () => {
  class FakeDatabaseSync {
    private readonly readOnly: boolean
    constructor(_path: string, opts?: { readOnly?: boolean }) {
      this.readOnly = opts?.readOnly === true
    }
    exec(): void {
      // 模拟损坏/锁：构造成功（惰性文件头读取）、首个 exec 抛
      throw new Error('file is not a database')
    }
    close(): void {
      if (this.readOnly) mocks.readOnlyCloseCalls++
    }
    prepare(): never {
      throw new Error('unexpected prepare')
    }
  }
  return { DatabaseSync: FakeDatabaseSync }
})

// vi.mock 提升语义下 import 后置是库内既定形态
import { rebuild } from '../../src/cache/rebuild.js'

test('R0910-W 增量只读 exec 失败路径关闭句柄（不再泄漏）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'rebuild-ro-close-'))
  const cachePath = join(root, '.cache', 'index.db')
  mkdirSync(join(root, '.cache'), { recursive: true })
  writeFileSync(cachePath, 'not a db', 'utf8')

  // 增量只读打开成功 → exec 抛 → 关句柄返回 null；随后全量路径同样 exec 抛并关闭后上抛
  expect(() => rebuild(root, cachePath)).toThrow()
  expect(mocks.readOnlyCloseCalls).toBe(1)

  rmSync(root, { recursive: true, force: true })
})
