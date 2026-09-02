/**
 * IR-4（独立重评 2026-09-02）：index.db 重建链 WAL 收口——
 * 1. 重建后库落 WAL 日志模式（读写不互堵 + 崩溃自愈面与事件库一致）；
 * 2. 库文件缺失时的孤儿 -wal/-shm 侧车清除（手动删库指引留下的侧车不再回放进新库）。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { rebuild } from '../../src/cache/rebuild.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

/** 最小书 fixture：book.yaml 即可（账本/正文/摘要目录缺省 = 全零重建） */
function makeMinimalBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'ir4-wal-'))
  const cfg: BookConfig = {
    ...DEFAULT_CONFIG,
    book: { title: 'WAL测试书', genre: '玄幻' },
  }
  writeBookConfig(join(root, 'book.yaml'), cfg)
  return root
}

test('IR-4：重建后 index.db 落 WAL 日志模式', () => {
  const root = makeMinimalBook()
  const cachePath = join(root, '.cache', 'index.db')
  const r = rebuild(root, cachePath)
  expect(r.leadCount).toBe(0)

  const db = new DatabaseSync(cachePath, { readOnly: true })
  try {
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
  } finally {
    db.close()
  }
})

test('IR-4：库文件缺失 + 孤儿 -wal/-shm 侧车 → 建库前清除（不再回放进新库）', () => {
  const root = makeMinimalBook()
  const cachePath = join(root, '.cache', 'index.db')
  mkdirSync(join(root, '.cache'), { recursive: true })
  // 孤儿侧车在位、库本体缺失（= 用户按报错指引手动删库后的残留形态）
  writeFileSync(cachePath + '-wal', 'orphan-wal-garbage')
  writeFileSync(cachePath + '-shm', 'orphan-shm-garbage')

  const r = rebuild(root, cachePath)
  expect(r.chapterCount).toBe(0)
  // 重建成功且干净收口（close checkpoint）后侧车不残留
  expect(existsSync(cachePath + '-wal')).toBe(false)
  expect(existsSync(cachePath + '-shm')).toBe(false)
})
