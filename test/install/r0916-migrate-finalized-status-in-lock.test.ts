/**
 * R0916-P3-15（四轮处置批）回归：定稿基线迁移的 git 脏集（statusPorcelain）必须在
 * 清单锁内取。
 *
 * 修复前脏集在锁外算：status → 拿锁 → 写盘的窗口里他进程改稿/回滚会让脏集失真——
 * 锁内时刻已 dirty 的文件被旧快照判 clean，被误标 finalizedRevision（本文件红线：
 * 误判 final 断写）。修复后 status 移进 withManifestLock 临界段（幂等复查通过后、
 * 逐 entry 判定前）。
 *
 * 断言手法：两处 partial mock（importOriginal 透传真实现，仅包裹目标函数）记录
 * 事件序——status 调用必须严格落在 lock-in 与 lock-out 之间。修复前序为
 * ['status', 'lock-in', 'lock-out']（红），修复后 ['lock-in', 'status', 'lock-out']。
 * statusPorcelain 同步 mock 返回 ''（全 clean），真 git 无需安装/初始化（.git 目录
 * 只需存在——existsSync 探测不依赖其内容）。
 */
import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const h = vi.hoisted(() => ({ order: [] as string[] }))

vi.mock('../../src/git/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git/exec.js')>()
  return {
    ...actual,
    statusPorcelain: () => {
      h.order.push('status')
      return '' // 全 clean：entry 应被标 final（走完真实 computeRevision 链）
    },
  }
})

vi.mock('../../src/document/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/document/manifest.js')>()
  return {
    ...actual,
    withManifestLock: (manifestPath: string, fn: () => unknown) => {
      h.order.push('lock-in')
      try {
        return actual.withManifestLock(manifestPath, fn)
      } finally {
        h.order.push('lock-out')
      }
    },
  }
})

import { migrateFinalizedRevisions } from '../../src/install/migrate-finalized-revision.js'
import { readManifest } from '../../src/document/manifest.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempTracked(join(tmpdir(), 'clw-migrate-fin-lock-'))
  h.order.length = 0
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('R0916-P3-15：statusPorcelain 在清单锁内调用（脏集新鲜度对齐锁窗口），迁移照常生效', () => {
  // git 时代书库形态：.git 目录存在（statusPorcelain 已 mock，git 不真跑）+ 一份文档 + 清单
  mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
  writeFileSync(join(tmp, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  mkdirSync(join(tmp, '.git'), { recursive: true })
  mkdirSync(join(tmp, '项目'), { recursive: true })
  writeFileSync(
    join(tmp, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: 'doc-0', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null }),
    ].join('\n') + '\n',
    'utf-8',
  )

  const n = migrateFinalizedRevisions(tmp)

  // 迁移照常生效：clean 文档获定稿基线
  expect(n).toBe(1)
  const m = readManifest(join(tmp, '项目', '文档清单.jsonl'))
  const entry = m.entries.get('doc-0')
  expect(entry?.nodeType).toBe('document')
  if (entry?.nodeType === 'document') {
    expect(entry.finalizedRevision).toBeTruthy()
  }

  // 核心：status 严格在锁内（修复前 = 锁外先取，序为 status → lock-in → lock-out）
  expect(h.order).toEqual(['lock-in', 'status', 'lock-out'])
})
