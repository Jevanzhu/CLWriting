/**
 * P5-数据层（第七轮）回归——字数日记读失败降级。
 * readBaseline / readTodayDelta 原先 readFileSync 失败（权限/磁盘）直接抛 EACCES，
 * 打断上层字数统计流程；修复后返回 null（视作无记录）。
 *
 * 重评-0914-三轮 P3-11：读失败注入改平台分派（helpers/fs-deny.ts 单源）——posix 臂
 * 保持 chmod 0o000 语义；win 臂经 vi.mock 包装按产品读取函数注入 EACCES，摘除
 * skipIf(win32)，win 生产高发形态（杀毒/索引器拒读）本机真跑。
 */
import { test, expect, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendBaseline,
  appendWordsDelta,
  readBaseline,
  readTodayDelta,
  wordsDiaryPath,
} from '../../src/document/words-diary.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { denyRead } from '../helpers/fs-deny.js'

// win 臂 EACCES 注入的模块包装（posix 臂走 chmod 不依赖此包装）——见 helpers/fs-deny.ts 头注
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fs', actual) as typeof actual
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const { armFsNamespace } = await import('../helpers/fs-deny.js')
  return armFsNamespace('fsp', actual) as typeof actual
})

test('P5-数据层（第七轮）：日记文件读失败（权限）→ readBaseline/readTodayDelta 返 null 不抛', () => {
  const root = mkdtempTracked(join(tmpdir(), 'w-diary-fail-'))
  appendBaseline(root, '2026-08-21', 100)
  appendWordsDelta(root, '2026-08-21', 50)
  const deny = denyRead(wordsDiaryPath(root)) // 挡读（清库/恢复窗口的典型形态）
  try {
    expect(readBaseline(root, '2026-08-21')).toBeNull()
    expect(readTodayDelta(root, '2026-08-21')).toBeNull()
  } finally {
    deny.restore()
    rmSync(root, { recursive: true, force: true })
  }
})
