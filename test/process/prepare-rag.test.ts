/**
 * R1 接缝测试：prepare 加 ragRecallText 可选入参 —— M7 #37 第 6 节。
 *
 * 验收红线（spec）：
 * - 不传 → 无 RAG 段 → 行为逐字节不变
 * - 传入 → push 弹性段 flexibleRank 5
 * - 超预算 → RAG 段最先砍（5 > 4 > 3 > 2 > 1）
 */

import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter } from '../../src/cache/sync.js'
import { prepare } from '../../src/process/prepare.js'
import { DEFAULT_CONFIG, writeBookConfig } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

function makeBook(): { root: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), 'rag-prepare-'))
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 10, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p10',
  })
  syncLead(db, {
    编号: '伏笔-001', 标题: '秘密', 类型: '伏笔', 状态: '进行中', 开启章: 1,
    履历: [{ 章号: 1, 动词: '埋下', 证据: '线索' }], _path: 'p',
  })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止和解\n', 'utf-8')
  return { root, db }
}

test('R1: 不传 ragRecallText → 无 RAG 段（逐字节不变）', () => {
  const { root, db } = makeBook()

  const withoutRag = prepare(db, DEFAULT_CONFIG, root, ['伏笔-001'])
  const withUndefined = prepare(db, DEFAULT_CONFIG, root, ['伏笔-001'], undefined)
  const withEmpty = prepare(db, DEFAULT_CONFIG, root, ['伏笔-001'], '')

  // 三者完全一致（逐字节不变）
  expect(withUndefined.sections).toEqual(withoutRag.sections)
  expect(withUndefined.text).toBe(withoutRag.text)
  expect(withUndefined.estimatedTokens).toBe(withoutRag.estimatedTokens)
  expect(withEmpty.sections).toEqual(withoutRag.sections)

  // 无 RAG 段
  expect(withoutRag.sections.find((s) => s.title === 'RAG 召回')).toBeUndefined()

  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('R1: 传入 ragRecallText → push 弹性段 flexibleRank 5', () => {
  const { root, db } = makeBook()
  const ragText = '【RAG 召回】某场景的相关正文片段。'

  const r = prepare(db, DEFAULT_CONFIG, root, ['伏笔-001'], ragText)

  const ragSection = r.sections.find((s) => s.title === 'RAG 召回')
  expect(ragSection).toBeDefined()
  expect(ragSection!.essential).toBe(false)
  expect(ragSection!.flexibleRank).toBe(5)
  expect(ragSection!.content).toBe(ragText)

  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('R1: 超预算时 RAG 段（rank 5）最先砍', () => {
  const { root, db } = makeBook()
  // RAG 文本足够大使其单独超预算（小预算逼裁剪）
  const ragText = 'RAG 召回正文片段，' + '这是一段较长的召回内容用于触发预算裁剪。'.repeat(20)
  const tightConfig: BookConfig = {
    ...DEFAULT_CONFIG,
    budget: { ...DEFAULT_CONFIG.budget, input_per_chapter: 200 },
  }

  const r = prepare(db, tightConfig, root, ['伏笔-001'], ragText)

  expect(r.trimmed).toBe(true)
  // RAG 段被整段移除（rank 5 最先砍）
  expect(r.sections.find((s) => s.title === 'RAG 召回')).toBeUndefined()
  expect(r.trimLog.some((l) => l.includes('RAG 召回'))).toBe(true)

  db.close()
  rmSync(root, { recursive: true, force: true })
})
