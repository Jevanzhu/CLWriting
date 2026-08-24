/**
 * N2（五十九轮）回归：正文区目录遍历统一 walk-md 共享口径。
 *
 * state 状态机三个本地 walk（findUnfinishedChapter / unfinishedPieceNames /
 * maxFileNameChapter）原先裸 statSync（跟随 symlink）+ 无 visited 递归——
 * 正文区 symlink 环 → RangeError 崩进门。统一后：环被剪枝、书外 symlink 不跟随。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 干净短篇集仓库（无布线 → detectState 全程走本地 walk，不再经 rebuild walkChapters 兜底）。 */
function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'n2-walk-'))
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  return root
}

/** 短篇定稿登记（正文 + manifest finalizedRevision 基线）。 */
function finalizePiece(root: string, num: number): string {
  const rel = `写作/正文/${String(num).padStart(3, '0')}-篇.md`
  const abs = join(root, rel)
  writeFileSync(abs, `---\n章号: ${num}\n标题: 篇${num}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${num}篇正文。\n`, 'utf-8')
  const m = readManifest(join(root, '项目', '文档清单.jsonl'))
  upsertEntry(m, {
    id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
    finalizedRevision: computeRevision(abs), finalizedAt: new Date().toISOString(),
  })
  writeManifest(join(root, '项目', '文档清单.jsonl'), m)
  return rel
}

test('N2: 正文区 symlink 环（a→b、b→a）不无限递归——detectState 正常判定不崩', () => {
  const root = makeShortBook()
  finalizePiece(root, 1)
  // 造环：写作/正文/a → b，b → a
  mkdirSync(join(root, '写作', '正文', 'b'), { recursive: true })
  symlinkSync(join(root, '写作', '正文', 'b'), join(root, '写作', '正文', 'a'))
  symlinkSync(join(root, '写作', '正文', 'a'), join(root, '写作', '正文', 'b', 'a'))
  // 旧实现：findUnfinishedChapter/unfinishedPieceNames/maxFileNameChapter 的裸
  // statSync 跟随 symlink 递归 a→b→a → RangeError 崩进门；新口径剪枝后正常返回
  const d = detectState(root, SHORT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) expect(d.nextChapter).toBe(2)
  rmSync(root, { recursive: true, force: true })
})

test('N2: 正文区指向书外的 symlink 章（.md 直链）不参与章号推算（根界 fail-closed）', () => {
  const root = makeShortBook()
  finalizePiece(root, 1)
  // 书外目录放一个高章号章（旧实现跟随 symlink 整读 → maxFileNameChapter 抬到 9）
  const outside = mkdtempSync(join(tmpdir(), 'n2-outside-'))
  writeFileSync(join(outside, '009-外链.md'), '---\n章号: 9\n标题: 外链\n---\n书外内容', 'utf-8')
  symlinkSync(join(outside, '009-外链.md'), join(root, '写作', '正文', '009-外链.md'))
  const d = detectState(root, SHORT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) expect(d.nextChapter).toBe(2) // 书外 symlink 不抬高章号
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
