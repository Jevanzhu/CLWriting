/**
 * R49-16（评审 R49）回归：purgeTrash 条目定位读改 strict。
 *
 * 此前条目定位用容错版 readTrashManifest（读失败返 []）——瞬态读失败（EBUSY/EACCES/
 * EIO）会把在册条目误判 NOT_FOUND（作者以为没删成、条目悬置成幽灵）。修复后走
 * readTrashManifestStrict（与 restoreTrash 入口 / purge RMW 段 R27-40 同口径），
 * strict 读失败按 WRITE_ERROR 信封如实上报（物理删除未发生，不可逆动作未成，重试
 * 即续）。mock readFileSync 仅对 .trash-manifest.jsonl 抛 EBUSY 构造瞬态读失败。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FAIL = vi.hoisted(() => ({ manifestRead: true }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p, ...rest) => {
      if (FAIL.manifestRead && typeof p === 'string' && p.includes('.trash-manifest.jsonl')) {
        throw Object.assign(new Error('EBUSY: 瞬时占用（模拟同步盘扫描锁）'), { code: 'EBUSY' })
      }
      return (actual.readFileSync as typeof readFileSync)(p, ...rest)
    }) as typeof readFileSync,
  }
})

import { purgeTrash, readTrashManifest } from '../../src/document/trash.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeTrashedBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r49-16-purge-'))
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  writeFileSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'), '旧内容', 'utf-8')
  writeFileSync(
    join(root, '工作区', '.trash', '.trash-manifest.jsonl'),
    JSON.stringify({ id: 'doc_a', originalPath: '写作/正文/0001-旧稿.md', trashedPath: '工作区/.trash/doc_a-旧稿.md', trashedAt: '', role: 'chapter' }) + '\n',
    'utf-8',
  )
  return root
}

test('R49-16: purgeTrash 清单瞬态读失败 → WRITE_ERROR（不再误报 NOT_FOUND），物理删除不发生', async () => {
  const root = makeTrashedBook()
  const trashFile = join(root, '工作区', '.trash', 'doc_a-旧稿.md')
  const r = await purgeTrash(root, 'doc_a')
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('WRITE_ERROR') // 修复前：容错读返 [] → 误报 NOT_FOUND
  expect(r.reason).toContain('回收站清单读取失败')
  expect(existsSync(trashFile)).toBe(true) // 不可逆动作未成（重试即续）
  FAIL.manifestRead = false // 解除 mock 故障后再验证条目未动（本文件自身读也走 mock）
  expect(readTrashManifest(root)).toHaveLength(1)
  // 瞬态恢复后重试 → 正常永久删（非死路）
  const retry = await purgeTrash(root, 'doc_a')
  expect(retry.ok).toBe(true)
  expect(existsSync(trashFile)).toBe(false)
  expect(readTrashManifest(root)).toHaveLength(0)
})

test('R49-16: 在册可读时 NOT_FOUND 契约不变（未知 id）', async () => {
  FAIL.manifestRead = false
  const root = makeTrashedBook()
  try {
    const r = await purgeTrash(root, 'doc_none')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('NOT_FOUND')
    expect(existsSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
