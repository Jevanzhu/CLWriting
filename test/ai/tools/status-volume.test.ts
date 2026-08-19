/**
 * GG-P2-6 回归（工具端到端）：chapter_status 汇总的卷号走三层链。
 *
 * fixture 长篇书的 book.yaml 不配 volume_size（断链条件）；手工造 .cache/index.db
 * 写到第 10 章。global.json defaultVolumeSize=5 → ceil(10/5)=2 卷；
 * 断链旧行为（第三参硬编码 50）= ceil(10/50)=1 卷。工具上下文 userDataPath
 * 与生产同形（chat 编排 executeChatTool 构造 ToolContext 时下发）。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { createAllTables } from '../../../src/cache/schema.js'
import { syncChapter } from '../../../src/cache/sync.js'
import { chapterStatus } from '../../../src/ai/tools/status.js'

let workDir = ''
let userDataPath = ''
let bookRoot = ''

beforeEach(() => {
  workDir = makeDualTrackWorkdir()
  bookRoot = join(workDir, '长篇', LONG_BOOK)
  // 书缓存：写到第 10 章（工具只读 .cache/index.db，不 rebuild——db 即真相）
  mkdirSync(join(bookRoot, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(bookRoot, '.cache', 'index.db'))
  createAllTables(db)
  for (let n = 1; n <= 10; n++) {
    syncChapter(db, {
      章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '强',
      情绪定位: '铺垫', _wordCount: 2000, _path: `p${n}`,
    })
  }
  db.close()
  // 书库级 global.json：defaultVolumeSize=5（下界；10 % 5 === 0 → 卷号跳变最锐利）
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-gg26tool-'))
  writeFileSync(
    join(userDataPath, 'global.json'),
    JSON.stringify({ defaultVolumeSize: 5 }),
    'utf8',
  )
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('chapter_status 卷号全局托底（GG-P2-6）', () => {
  it('书级未配 + global defaultVolumeSize=5 → 第 10 章报「第 2 卷」（断链旧行为=第 1 卷）', () => {
    const r = chapterStatus({ bookRoot, bookName: LONG_BOOK, userDataPath }, {})
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('已写到第 10 章')
    expect(r.summary).toContain('第 2 卷')
  })

  it('对照：userDataPath 为 null（global 层不可达）→ 回落硬编码 50 → 第 1 卷', () => {
    const r = chapterStatus({ bookRoot, bookName: LONG_BOOK, userDataPath: null }, {})
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('第 1 卷')
  })
})
