/**
 * GG-P2-6 回归（工具端到端）：chapter_status 汇总的卷号走三层链。
 *
 * fixture 长篇书的 book.yaml 不配 volume_size（断链条件）；手工造 .cache/index.db
 * 写到第 10 章。global.json defaultVolumeSize=5 → ceil(10/5)=2 卷；
 * 断链旧行为（第三参硬编码 50）= ceil(10/50)=1 卷。工具上下文 userDataPath
 * 与生产同形（chat 编排 executeChatTool 构造 ToolContext 时下发）。
 */
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeDualTrackWorkdir, LONG_BOOK } from '../../studio/fixtures.js'
import { createAllTables } from '../../../src/cache/schema.js'
import { syncChapter } from '../../../src/cache/sync.js'
import { chapterStatus } from '../../../src/ai/tools/status.js'
import { readManifest, upsertEntry, writeManifest } from '../../../src/document/manifest.js'

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
  // 低级项（第六轮）：currentChapter 现按清单定稿章收口——补登 1..10 章 finalizedRevision，
  // 使「写到第 10 章」在缓存与清单两侧同真（夹具 manifest 原本只定稿到前几章）
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const manifest = readManifest(manifestPath)
  for (let n = 1; n <= 10; n++) {
    const already = [...manifest.entries.values()].some((e) => e.path.includes(`000${n}`))
    if (already) continue
    upsertEntry(manifest, {
      id: `doc_vol_${n}`,
      nodeType: 'document',
      path: `写作/正文/000${n}-第${n}章.md`,
      parentId: null,
      finalizedRevision: `sha256:${String(n).padStart(64, '0')}`,
      finalizedAt: '2026-08-21T00:00:00.000Z',
    })
  }
  writeManifest(manifestPath, manifest)
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

  it('低级项（第六轮）：缓存里的第 11 章是草稿（清单未定稿）→ currentChapter 不计入', () => {
    // 夹具 manifest 只定稿到第 10 章（下方补登）——缓存 chapters 表再多一章草稿，
    // 「已写到第 N 章」仍停在第 10 章（与近况复述/判态同口径）
    const db = new DatabaseSync(join(bookRoot, '.cache', 'index.db'))
    syncChapter(db, {
      章号: 11, 标题: '第11章', 钩子类型: '悬念钩', 钩子强弱: '强',
      情绪定位: '铺垫', _wordCount: 2000, _path: 'p11',
    })
    db.close()
    const r = chapterStatus({ bookRoot, bookName: LONG_BOOK, userDataPath }, {})
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('已写到第 10 章')
    expect(r.summary).not.toContain('已写到第 11 章')
  })
})

describe('T2 批 assembleStatus 第三参显式 resolve（chapter_status 调用点）', () => {
  it('书级显式 volume_size=3 → 第 10 章按 3 分卷报「第 4 卷」（调用点不得缺省穿透）', () => {
    // 书级键是三层链第一环：调用点显式 resolve 后仍须原样生效（防回归成硬编码/漏传）
    const yamlPath = join(bookRoot, 'book.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    // 在既有 book: 块内插入键（追加重复顶层键会被解析器丢弃）
    writeFileSync(yamlPath, yaml.replace('book:\n', 'book:\n  volume_size: 3\n'), 'utf8')
    const r = chapterStatus({ bookRoot, bookName: LONG_BOOK, userDataPath }, {})
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('第 4 卷')
  })
})
