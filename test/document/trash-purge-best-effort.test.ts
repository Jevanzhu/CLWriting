/**
 * 低级项（第六轮）回归 —— purgeTrash 条目写回 best-effort。
 *
 * 主文件已物理删除（不可逆动作已成）后，trash manifest 写失败（磁盘满/权限）不应把
 * 整端点打成 500：吞掉写失败仍返回 ok:true；残留条目下次对该 id 操作报 NOT_FOUND 自愈。
 * mock atomicWriteFile 仅对 .trash-manifest.jsonl 抛 EACCES 构造「读得进、写不出」。
 */
import { test, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  let failNextTrashWrite = true // 只失败一次：先证「写失败不上抛」，再证残留条目自愈
  return {
    ...orig,
    atomicWriteFile: vi.fn((p: string, data: string, opts?: { fsync?: boolean }) => {
      if (failNextTrashWrite && p.includes('.trash-manifest.jsonl')) {
        failNextTrashWrite = false
        throw Object.assign(new Error('EACCES: 权限不足（模拟磁盘故障）'), { code: 'EACCES' })
      }
      return orig.atomicWriteFile(p, data, opts)
    }),
  }
})

import { purgeTrash, readTrashManifest } from '../../src/document/trash.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeTrashedBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-trash-purge-be-'))
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  writeFileSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'), '旧内容', 'utf-8')
  writeFileSync(
    join(root, '工作区', '.trash', '.trash-manifest.jsonl'),
    JSON.stringify({ id: 'doc_a', originalPath: '写作/正文/0001-旧稿.md', trashedPath: '工作区/.trash/doc_a-旧稿.md', trashedAt: '', role: 'chapter' }) + '\n',
    'utf-8',
  )
  return root
}

test('低级项（第六轮）：purgeTrash 条目写失败 → best-effort ok:true，物理删除照发生', async () => {
  const root = makeTrashedBook()
  try {
    const r = await purgeTrash(root, 'doc_a')
    expect(r.ok).toBe(true) // 修复前：writeTrashManifest 的 EACCES 直接上抛（端点 500）
    expect(existsSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'))).toBe(false) // 不可逆动作已发生
    expect(readTrashManifest(root).some((e) => e.id === 'doc_a')).toBe(true) // 条目残留（写失败未除名）
    // 残留自愈：磁盘恢复后再次 purge → 条目正常除名；此后该 id 报 NOT_FOUND
    expect((await purgeTrash(root, 'doc_a')).ok).toBe(true)
    expect(readTrashManifest(root).some((e) => e.id === 'doc_a')).toBe(false)
    const third = await purgeTrash(root, 'doc_a')
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.code).toBe('NOT_FOUND')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
