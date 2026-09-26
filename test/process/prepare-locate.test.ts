/**
 * 阶段 24 章节结构操作（留洞制）批 A / S2：prepare findChapterByNumber 宽容集统一
 * 双向锚定（执行方案 §五 风险登记 5）。
 *
 * 正向：`150—标题.md`（em 破折号）/`150 标题.md`（空白）宽容命名形态从失明变可见——
 * 原 parseChapterFileName 窄正则仅认 `-`，AI 前章正文结尾配段对这类章静默缺失。
 * 反向锚定：`150-标题.md` 连字符既有行为不变；`150.md` 裸数字名维持不识别
 * （chapterNoFromName 契约：数字后须分隔符或串尾，filename.test.ts 钉定）。
 * 并入回退：前章被并入目标章后，前章正文结尾 = 目标章正文结尾（衔接点语义）。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncChapter } from '../../src/cache/sync.js'
import { prepare } from '../../src/process/prepare.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

/** 最小备料书：缓存 currentChapter=150（前章 = 150，PL-1）+ book.yaml */
function makeBook(): { root: string; db: DatabaseSync } {
  const root = mkdtempTracked(join(tmpdir(), 'clw-prepare-locate-'))
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 150,
    标题: '前章',
    钩子类型: '悬念钩',
    钩子强弱: '强',
    情绪定位: '铺垫',
    _wordCount: 3000,
    _path: 'p150',
  })
  return { root, db }
}

/** 写第 150 章正文（文件名形态参数化；正文末尾片段可断言） */
const writeCh150 = (root: string, fileName: string, body = '宽容形态的前章正文。雪夜收束。') => {
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', fileName),
    `---\n章号: 150\n标题: 前章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n${body}\n`,
  )
}

const sectionOf = (root: string, db: DatabaseSync) => {
  const r = prepare(db, DEFAULT_CONFIG, root, [])
  const sec = r.sections.find((s) => s.title === '前章正文结尾')
  return sec
}

test('S2 正向锚定：em 破折号 `150—前章.md` 前章正文结尾出现（原窄正则失明形态）', () => {
  const { root, db } = makeBook()
  writeCh150(root, '150—前章.md')
  const sec = sectionOf(root, db)
  expect(sec).toBeDefined()
  expect(sec!.content).toContain('【第150章正文结尾】')
  expect(sec!.content).toContain('雪夜收束。')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('S2 正向锚定：空白分隔 `150 前章.md` 同收', () => {
  const { root, db } = makeBook()
  writeCh150(root, '150 前章.md')
  const sec = sectionOf(root, db)
  expect(sec).toBeDefined()
  expect(sec!.content).toContain('【第150章正文结尾】')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('S2 反向锚定：连字符 `150-前章.md` 既有行为不变', () => {
  const { root, db } = makeBook()
  writeCh150(root, '150-前章.md')
  const sec = sectionOf(root, db)
  expect(sec).toBeDefined()
  expect(sec!.content).toContain('【第150章正文结尾】')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('S2 正向锚定：裸数字 `150.md` 扩集后同收（阶段 36 单源扩集，原反向锚定随拍板翻向）', () => {
  const { root, db } = makeBook()
  writeCh150(root, '150.md')
  const sec = sectionOf(root, db)
  expect(sec).toBeDefined()
  expect(sec!.content).toContain('【第150章正文结尾】')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('S2 并入回退：前章被并入目标章后，前章正文结尾 = 目标章正文结尾', () => {
  const { root, db } = makeBook()
  // 合并终态：150 已被并入 149（源章摘除，目标章 fm 并入 登记 + 承载正文）
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '0149-目标.md'),
    '---\n章号: 149\n标题: 目标\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n并入: 150\n---\n\n目标章原有正文。并入后的收束段。雪夜里的焦痕尚未散尽。\n',
  )
  const sec = sectionOf(root, db)
  expect(sec).toBeDefined()
  expect(sec!.content).toContain('【第150章正文结尾】')
  // 衔接点 = 目标章（并入后正文的实际末尾）
  expect(sec!.content).toContain('雪夜里的焦痕尚未散尽。')
  db.close()
  rmSync(root, { recursive: true, force: true })
})
