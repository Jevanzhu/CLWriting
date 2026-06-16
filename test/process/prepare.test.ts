import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter, syncSummary } from '../../src/cache/sync.js'
import { prepare, estimateTokens } from '../../src/process/prepare.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

function makeBookWithMaterial(): { root: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))
  // book.yaml
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)

  // 缓存
  const dbPath = join(root, '.cache', 'index.db')
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  createAllTables(db)

  syncChapter(db, {
    章号: 150, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p150',
  })
  syncLead(db, {
    编号: '伏笔-031', 标题: '灭门真凶', 类型: '伏笔', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '焦痕' }], _path: 'p',
  })

  // 文风铁律
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止强行和解\n## 硬约束\n单句≤60字', 'utf-8')

  // 文风样章
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '样章库', '战斗', '战斗-001.md'),
    '---\n场景: 战斗\n来源: 作者原作\n---\n刀光没入雪雾。', 'utf-8')

  // 章摘要
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '150.md'), '前章内容回顾。', 'utf-8')
  syncSummary(db, 'chapter', 150, join(root, '定稿', '摘要', '章摘要', '150.md'))

  return { root, db }
}

test('prepare: 刚需段全在（近况/账本/铁律）', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, ['伏笔-031'])
  const titles = r.sections.filter((s) => s.essential).map((s) => s.title)
  expect(titles).toContain('近况')
  expect(titles).toContain('本章推进的账本')
  expect(titles).toContain('文风铁律')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 无裁剪时 trimmed=false', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, ['伏笔-031'])
  expect(r.trimmed).toBe(false)
  expect(r.text).not.toContain('因预算裁剪')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 超预算按优先级裁剪（弹性④→③→②→①），刚需不丢', () => {
  const { root, db } = makeBookWithMaterial()
  // 设极小预算（100 token），逼裁剪
  const cfg: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, input_per_chapter: 100 } }
  const r = prepare(db, cfg, root, ['伏笔-031'])

  expect(r.trimmed).toBe(true)
  expect(r.text).toContain('因预算裁剪')
  // 刚需段必须保留
  const essentialTitles = r.sections.filter((s) => s.essential).map((s) => s.title)
  expect(essentialTitles).toContain('近况')
  expect(essentialTitles).toContain('文风铁律')
  // 弹性段被裁
  const flexTitles = r.sections.filter((s) => !s.essential).map((s) => s.title)
  // 文风样章（弹性②）应被裁掉
  expect(flexTitles).not.toContain('文风样章')

  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 文风轻注入只取 1 段', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, [])
  const styleSection = r.sections.find((s) => s.title === '文风样章')
  if (styleSection) {
    // 轻注入 = 1 段
    expect(styleSection.content.split('\n\n').length).toBeLessThanOrEqual(1)
  }
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('estimateTokens: 中文 0.6 token/字', () => {
  expect(estimateTokens('')).toBe(0)
  const t = estimateTokens('一二三四五六七八九十') // 10 字
  expect(t).toBe(6) // 10 * 0.6
})
