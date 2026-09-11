/**
 * R0911-D-P3-1（2026-09-11 全量重评 GLM-5.3 修复批）回归：buildIndex 增量路径
 * 对损坏库自愈。
 *
 * 同文件 resetRagIndex（R35-13）与 ragIndexState 早有损坏自愈/收口（识别
 * SQLITE_NOTADB 族 → 删库全新建 / 返回 corrupt），唯独 buildIndex 增量路径裸
 * openRagDb——文件级损坏（断电/杀软半写后的非 SQLite 字节流）时英文 SQLite 错
 * 直穿上抛，建索引入口（作者自救的第一操作）同死。修复后对齐同款自愈链：
 * 确认损坏 → 删库（连 -wal/-shm）→ 全新建 → 全量重建自然承接。桩 embed 不联网。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex } from '../../src/rag/index.js'
import { writeChapter } from '../helpers/chapter.js'
import { openRagDb, readAllChunks, readAllChapterFingerprints } from '../../src/rag/store.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

describe('R0911-D-P3-1：buildIndex 增量路径损坏库自愈', () => {
  let bookRoot: string
  const dbPath = (): string => join(bookRoot, '.cache', 'rag.db')

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r0911-selfheal-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    for (const n of [1, 2]) {
      const meta: ChapterMeta = {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 100,
      }
      writeChapter(
        join(bookRoot, '写作', '正文', `${n}-第${n}章.md`),
        meta,
        `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`,
      )
    }
  })

  afterEach(() => {
    rmSync(bookRoot, { recursive: true, force: true })
  })

  /** 桩 embed：确定性 3 维向量（不联网，口径同 index.test.ts） */
  function stubEmbed(_endpoint: string, _model: string, _key: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3]))
  }

  it('垃圾字节损坏的 rag.db → buildIndex 自愈删库重建，不抛且正常返回', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    // 先正常建一次索引（增量路径的「已有库」前置态）
    const first = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    expect(first.ok).toBe(true)
    expect(first.chapterCount).toBe(2)

    // 制造文件级损坏：主库整体覆写为非 SQLite 字节流，并留一份侧车残留
    //（口径同 r35-db-corruption-recovery.test.ts 的损坏注入）
    writeFileSync(dbPath(), 'this is definitely not a sqlite database at all'.repeat(8), 'utf8')
    writeFileSync(dbPath() + '-wal', 'stale wal bytes', 'utf8')

    // 修复点：增量路径不再裸抛英文 SQLite 错——自愈删库后全量重建正常返回
    const second = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    expect(second.ok).toBe(true)
    expect(second.chapterCount).toBe(2) // 空库无指纹/游标 → 全部章重新索引
    expect(second.chunkCount).toBeGreaterThan(0)

    // 损坏残留清干净（连 -wal 侧车），重建后的库可用且内容完整
    expect(existsSync(dbPath() + '-wal')).toBe(false)
    const db = openRagDb(bookRoot)
    try {
      expect(readAllChunks(db).length).toBeGreaterThan(0)
      expect(readAllChapterFingerprints(db).size).toBe(2)
    } finally {
      db.close()
    }
  })

  it('自愈后再跑一轮：增量语义恢复正常（已索引章不重嵌）', async () => {
    const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    // 预置损坏库（.cache 目录先建——openRagDb 之外唯一会建它的是其自身迁移逻辑）
    mkdirSync(join(bookRoot, '.cache'), { recursive: true })
    writeFileSync(dbPath(), 'corrupted garbage bytes, not sqlite'.repeat(4), 'utf8')
    const healed = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    expect(healed.ok).toBe(true)

    const again = await buildIndex(bookRoot, config, 'stub-key', stubEmbed)
    expect(again.ok).toBe(true)
    expect(again.chapterCount).toBe(0) // 指纹比对命中 → 增量跳过
    expect(again.chunkCount).toBe(0)
  })
})
