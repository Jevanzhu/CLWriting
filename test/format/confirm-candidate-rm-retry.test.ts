/**
 * R49-15（评审 R49）回归：confirmCandidate 删候选文件收编 rmWithRetry。
 *
 * 此前 addEntry 落盘后裸 rmSync(fp, { force: true })——win 杀软/索引器对刚操作过的
 * 候选文件瞬时锁（EPERM/EBUSY）直败，把已入库的作者确认反转为调用方失败。修复后走
 * rmWithRetry（R40-18「确实要删」原语，3×50ms 退避；退避后仍失败仍上抛，错误路径
 * 语义不变）。本测以 pass-through spy 锚定路由：删候选必经 rmWithRetry（回退为裸
 * rmSync 则 spy 零调用即红）；确认行为（条目入库 + 候选删除）不变。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rmSpyState = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return {
    ...orig,
    rmWithRetry: (p: string, opts?: Parameters<typeof orig.rmWithRetry>[1]) => {
      rmSpyState.calls.push(p)
      return orig.rmWithRetry(p, opts)
    },
  }
})

import {
  addCandidate,
  confirmCandidate,
  type StyleCandidate,
} from '../../src/format/style-candidate.js'
import { readEntries, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('R49-15: confirmCandidate 删候选走 rmWithRetry（spy 锚定路由），确认行为不变', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r49-15-candidate-'))
  try {
    const candidate: StyleCandidate = {
      类型: '禁词',
      场景: '通用',
      来源: '改稿行为',
      正文: '深吸一口气',
      状态: '待确认',
      创建: '2026-09-01',
    }
    const rel = addCandidate(root, candidate)
    // resolveWithinRoot 对在盘目标返回 realpath（macOS tmpdir /var→/private/var），
    // 预期路径按 realpath 口径对齐
    const realFp = realpathSync(join(root, rel))
    rmSpyState.calls = []
    const entryPath = confirmCandidate(root, rel)
    expect(entryPath).toBe(`${ENTRIES_DIR}/禁词/通用-001.md`)
    expect(existsSync(join(root, rel))).toBe(false) // 候选已删
    const { entries } = readEntries(join(root, ENTRIES_DIR), '禁词')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.正文).toBe('深吸一口气')
    // 路由锚定：删候选必经 rmWithRetry（回退裸 rmSync 则本断言红）
    expect(rmSpyState.calls).toEqual([realFp])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
