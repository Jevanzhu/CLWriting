/**
 * R47-24（四十七轮）回归：forgetMigratedRoots——migratedRoots 只增不减的释放口。
 *
 * 标记语义（E-4）：迁移写落地前置位，并发 read 命中标记即短路、不再重复入队迁移写。
 * forget 后同书根若再遇旧格式文件（外部回写/同名重建书），必须重新走迁移而非被陈旧
 * 标记短路。精确性：只清传入键，其它书根的标记不受影响（文件尾保持旧格式 = 标记仍在
 * 短路的可观测形态，先例 calls.test.ts「迁移后再读不再重复触发迁移写」）。
 * books.ts 删书/改名接线（forgetBookKeyedCaches 同位）在 r47 静态面之外，由既有
 * books-delete / books-rename 家族回归兜底，此处直测导出函数本身。
 */
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkAiCallBudget, forgetMigratedRoots } from '../../src/ai/calls.js'
import type { BookConfig } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const dirs: string[] = []
function tempBook(): string {
  const d = mkdtempTracked(join(tmpdir(), 'clwriting-r47-calls-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const CONFIG = { budget: { calls_per_chapter: 3 } } as unknown as BookConfig
const OLD = (chapter: number): string =>
  JSON.stringify({ chapter, used: 2, inputTokens: 100, outputTokens: 200 }) + '\n'

/** 手写一份旧格式 ai-calls.json。 */
function writeOldFormat(root: string, chapter = 5): void {
  mkdirSync(join(root, '.cache'), { recursive: true })
  writeFileSync(join(root, '.cache', 'ai-calls.json'), OLD(chapter))
}

/** 文件是否已迁移为新格式（chapter 为对象而非 number）。 */
function isMigrated(root: string): boolean {
  const rec = JSON.parse(readFileSync(join(root, '.cache', 'ai-calls.json'), 'utf8')) as {
    chapter: unknown
  }
  return typeof rec.chapter === 'object' && rec.chapter !== null
}

describe('R47-24: forgetMigratedRoots 精确清除迁移标记', () => {
  it('forget 后同书根再遇旧格式 → 重新迁移（不再被陈旧标记短路）', () => {
    const root = tempBook()
    writeOldFormat(root)
    checkAiCallBudget(root, 5, CONFIG) // 首读触发迁移 + 置标记
    expect(isMigrated(root)).toBe(true)

    forgetMigratedRoots(root) // R47-24：释放口

    // 模拟外部回写旧格式（删书墓地恢复/同名重建书搬运等形态）
    writeOldFormat(root)
    const b = checkAiCallBudget(root, 5, CONFIG) // 标记已清 → 重新迁移
    expect(b.ok).toBe(true)
    if (b.ok) expect(b.used).toBe(2) // 旧格式账目照常读出
    expect(isMigrated(root)).toBe(true) // 迁移写重新落地
  })

  it('forget 只清传入键——其它书根的标记不受影响（短路形态可观测）', () => {
    const rootA = tempBook()
    const rootB = tempBook()
    writeOldFormat(rootA)
    writeOldFormat(rootB)
    checkAiCallBudget(rootA, 5, CONFIG) // 两书各自迁移 + 各自置标记
    checkAiCallBudget(rootB, 5, CONFIG)
    expect(isMigrated(rootA)).toBe(true)
    expect(isMigrated(rootB)).toBe(true)

    forgetMigratedRoots(rootA) // 只清 A

    // 两书都回写旧格式后再读：A 重新迁移（标记已清）；B 标记仍在 → 短路不重写（文件保持旧格式）
    writeOldFormat(rootA)
    writeOldFormat(rootB)
    checkAiCallBudget(rootA, 5, CONFIG)
    checkAiCallBudget(rootB, 5, CONFIG)
    expect(isMigrated(rootA)).toBe(true) // A：forget 生效，重新迁移
    expect(isMigrated(rootB)).toBe(false) // B：标记未被动过，短路保持旧格式
  })

  it('forget 不存在的键为 no-op（不抛）', () => {
    expect(() => forgetMigratedRoots(join(tmpdir(), 'r47-never-existed'))).not.toThrow()
  })
})
