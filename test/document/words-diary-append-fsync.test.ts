/**
 * 0918独立重评二轮修复批（B104）：字数日记追加后 best-effort fsync 回归。
 *
 * 机理：appendWordsDelta / appendBaseline 裸 appendFileSync 无 fsync——对照同为
 * append-only 的 journal appendLineAsync（追加后 fsyncFile）的耐久纪律，掉电丢尾部行
 * 虽有读侧逐行容错自愈，但压缩损失面是白给的。修法：追加后复用 journal.fsyncFile
 *（单源导出，勿复制实现；吞错同口径 best-effort）。
 *
 * 断言形态：vi.mock 拦截 words-diary → journal 的 fsyncFile 调用（ESM 命名导出无法
 * spyOn，mock 工厂透传原实现 + 计数；修复前该调用不发生 → 红）。
 */
import { test, expect, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const fsyncSpy = vi.hoisted(() => vi.fn())

vi.mock('../../src/document/journal.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/document/journal.js')>()
  return {
    ...orig,
    fsyncFile: (...args: Parameters<typeof orig.fsyncFile>) => {
      fsyncSpy(...args)
      return orig.fsyncFile(...args)
    },
  }
})

// vi.mock 由 vitest 提升到模块加载前执行——被测模块 words-diary 拿到的是 mock 后的
// journal 命名空间（下方 import 位置不影响拦截）
import { appendBaseline, appendWordsDelta, wordsDiaryPath } from '../../src/document/words-diary.js'

test('B104: appendWordsDelta 追加后 fsync 一次（journal.fsyncFile 单源复用）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-fsync-'))
  try {
    fsyncSpy.mockClear()
    appendWordsDelta(root, '2026-09-18', 42, 'doc-1')
    expect(fsyncCallsOn(root)).toBe(1)
    // 行本体照常落盘（fsync 不改写入语义）
    const fp = wordsDiaryPath(root)
    expect(existsSync(fp)).toBe(true)
    expect(readFileSync(fp, 'utf-8')).toContain('"delta":42')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('B104: appendBaseline 追加后同样 fsync（基线行耐久同纪律）', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-fsync-'))
  try {
    fsyncSpy.mockClear()
    appendBaseline(root, '2026-09-18', 12345)
    expect(fsyncCallsOn(root)).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 本次根上日记文件的 fsync 调用次数（排除他路径噪音）。 */
function fsyncCallsOn(root: string): number {
  return fsyncSpy.mock.calls.filter((c) => c[0] === wordsDiaryPath(root)).length
}
