/**
 * R37-4（三十七轮批 A）回归——git() 同步 spawnSync 与 gitAsync() 异步 spawn 均
 * windowsHide: true。
 *
 * 缺陷：两处子进程 options 均未设 windowsHide——Windows 上每次 git 调用可能闪控制台
 * 窗口（Electron 桌面形态下可见，保存/落盘链高频触发）。包装 child_process 记录调用
 * 参数（真实实现保留，先例同 exec.test.ts P2-30 的 timeout 断言）。
 */
import { test, expect, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { git, gitAsync } from '../../src/git/exec.js'
import { makeGitBook } from '../helpers/book.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync), spawn: vi.fn(actual.spawn) }
})
import { spawnSync, spawn } from 'node:child_process'

const mockSpawnSync = vi.mocked(spawnSync)
const mockSpawn = vi.mocked(spawn)

test('R37-4: git()（spawnSync）调 git 带 windowsHide: true（win 不闪控制台窗）', () => {
  const root = makeGitBook()
  try {
    mockSpawnSync.mockClear()
    const r = git(['status'], root)
    expect(r.ok).toBe(true)
    expect(mockSpawnSync).toHaveBeenCalled()
    const opts = mockSpawnSync.mock.calls[0]![2] as { windowsHide?: boolean; timeout?: number }
    expect(opts.windowsHide).toBe(true)
    // R36-5/P2-30 既有超时语义不被本修复动到
    expect(opts.timeout).toBe(15000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R37-4: gitAsync()（spawn）调 git 带 windowsHide: true，且不动超时/AbortSignal 语义', async () => {
  const root = makeGitBook()
  try {
    mockSpawn.mockClear()
    const r = await gitAsync(['rev-parse', '--is-inside-work-tree'], root)
    expect(r.ok).toBe(true)
    expect(mockSpawn).toHaveBeenCalled()
    const opts = mockSpawn.mock.calls[0]![2] as { windowsHide?: boolean }
    expect(opts.windowsHide).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R37-4: statusPorcelain → git() 内层 spawnSync 同样透传 windowsHide', async () => {
  const root = makeGitBook()
  try {
    const { statusPorcelain } = await import('../../src/git/exec.js')
    mockSpawnSync.mockClear()
    expect(statusPorcelain(root)).not.toBeNull()
    const opts = mockSpawnSync.mock.calls[0]![2] as { windowsHide?: boolean }
    expect(opts.windowsHide).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
