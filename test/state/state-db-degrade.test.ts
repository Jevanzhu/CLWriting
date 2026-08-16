/**
 * RB-KN-P2-1：detectState 的缓存读取段（DatabaseSync 打开 + assembleStatus）降级。
 *
 * 原先该段无兜底——db 层故障（磁盘满/权限/损坏）直接从 detectState 抛出崩掉整个
 * enter；同文件 readRecapSnapshot 有 catch 降级先例，行为不一致。修复后降级态 2
 * （与 rebuild 失败同款人话：可删 .cache/index.db 重试），不崩。
 */
import { test, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/process/assemble.js', () => ({
  assembleStatus: vi.fn(() => {
    throw new Error('mock: db 统计层故障')
  }),
}))

const { detectState } = await import('../../src/state/state.js')
const { DEFAULT_CONFIG, writeBookConfig } = await import('../../src/format/yaml.js')

test('RB-KN-P2-1: 缓存读取段故障 → 降级态 2（不抛出崩 enter）', () => {
  const root = mkdtempSync(join(tmpdir(), 'clw-db-degrade-'))
  try {
    writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
    // 长篇结构：有 布线 → detectState 走「读缓存算 currentChapter」段
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    mkdirSync(join(root, '工作区'), { recursive: true })

    const d = detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(2)
    if (d.state === 2) {
      expect(d.parseErrors.some((p) => p.message.includes('缓存读取失败'))).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
