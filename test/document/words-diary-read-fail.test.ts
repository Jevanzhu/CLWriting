/**
 * P5-数据层（第七轮）回归——字数日记读失败降级。
 * readBaseline / readTodayDelta 原先 readFileSync 失败（权限/磁盘）直接抛 EACCES，
 * 打断上层字数统计流程；修复后返回 null（视作无记录）。
 */
import { test, expect } from 'vitest'
import { rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendBaseline, appendWordsDelta, readBaseline, readTodayDelta, wordsDiaryPath } from '../../src/document/words-diary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// Windows 无 POSIX 权限位（chmod 为 no-op/仅映射只读位），该守卫语义由 macOS/Linux CI 腿覆盖
test.skipIf(process.platform === 'win32')('P5-数据层（第七轮）：日记文件读失败（权限）→ readBaseline/readTodayDelta 返 null 不抛', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-fail-'))
  appendBaseline(root, '2026-08-21', 100)
  appendWordsDelta(root, '2026-08-21', 50)
  chmodSync(wordsDiaryPath(root), 0o000) // 挡读（清库/恢复窗口的典型形态）
  try {
    expect(readBaseline(root, '2026-08-21')).toBeNull()
    expect(readTodayDelta(root, '2026-08-21')).toBeNull()
  } finally {
    chmodSync(wordsDiaryPath(root), 0o644)
    rmSync(root, { recursive: true, force: true })
  }
})
