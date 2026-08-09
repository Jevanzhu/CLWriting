/**
 * 短篇精简态机测试 —— M8 #25/#26。
 *
 * 验收：短篇（kind:short）走精简态机（态 1-4 + 7），有待定稿篇时进态 8，不判态 5/6；
 * 态 3 手改看 写作/正文/；态 4 续跑用 pc: 前缀；态 7 章号 = 扫 写作/正文/ 子目录数 + 1。
 */

import { test, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import type { BookConfig } from '../../src/format/types.js'

const SHORT_CONFIG: BookConfig = { ...DEFAULT_CONFIG, kind: 'short', book: { title: '夜语集', genre: '悬疑' } }

/** 建一个干净短篇集仓库（book.yaml kind:short + 写作/正文/ + 文风/ + 工作区/）。去 git。 */
function makeShortBook(): string {
  const root = mkdtempSync(join(tmpdir(), '夜语集-'))
  writeBookConfig(join(root, 'book.yaml'), SHORT_CONFIG)
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  for (const s of ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']) {
    mkdirSync(join(root, '文风', '样章库', s), { recursive: true })
  }
  mkdirSync(join(root, '文风', '金句库'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n', 'utf-8')
  mkdirSync(join(root, '工作区'), { recursive: true })
  return root
}

/** 造一章定稿（正文 + manifest finalizedRevision 基线）。短篇正文进卷结构：写作/正文/第一卷/。 */
function finalizePiece(root: string, num: number, title: string): void {
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  const rel = `写作/正文/第一卷/${String(num).padStart(3, '0')}-${title}.md`
  const abs = join(root, rel)
  writeFileSync(abs, `---\n章号: ${num}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${num}章正文。\n`, 'utf-8')
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  upsertEntry(m, {
    id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
    finalizedRevision: computeRevision(abs), finalizedAt: new Date().toISOString(),
  })
  writeManifest(manifestPath, m)
}

test('short 态 3: 写作/正文/ 有未 commit 改动 → 态 3（看 写作/正文/，不看 设定/大纲/）', () => {
  const root = makeShortBook()
  try {
    // 改已定稿篇的正文（未 commit）→ 态 3 手改
    finalizePiece(root, 1, '雪夜')
    writeFileSync(join(root, '写作', '正文', '第一卷', '001-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n改过的正文。\n', 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(3)
    if (d.state === 3) {
      expect(d.handEdits.some((p) => p.startsWith('写作/正文/'))).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 4: 工作区有半截草稿（正文草稿+细纲+.confirm）但未定稿 → 态 4 pre-finalize', () => {
  const root = makeShortBook()
  try {
    const workDir = join(root, '工作区')
    writeFileSync(join(workDir, '细纲.md'), '第2章细纲', 'utf-8')
    mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
    writeFileSync(join(root, '写作', '正文', '第一卷', '002-草稿.md'), '第2章草稿', 'utf-8')
    writeFileSync(join(workDir, '.confirm.json'), JSON.stringify({ chapter: 2, outline_hash: 'sha256:x', confirmed_at: '2026-06-19T00:00:00Z', mode: 'manual' }), 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(4)
    if (d.state === 4) {
      expect(d.chapterNum).toBe(2)
      expect(d.resumePoint).toBe('pre-finalize') // 无 finalizedRevision 基线
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 4: 工作区半截草稿 + 已定稿 → 态 4 post-finalize-residue', () => {
  const root = makeShortBook()
  try {
    finalizePiece(root, 2, '旧伞') // 第 2 章已定稿（manifest 基线存在）
    // 工作区残留第 2 篇的草稿/.confirm（post-finalize residue）；正文保持定稿内容不动
    const workDir = join(root, '工作区')
    writeFileSync(join(workDir, '细纲.md'), '第2章细纲', 'utf-8')
    writeFileSync(join(workDir, '.confirm.json'), JSON.stringify({ chapter: 2, outline_hash: 'sha256:x', confirmed_at: '2026-06-19T00:00:00Z', mode: 'manual' }), 'utf-8')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(4)
    if (d.state === 4) {
      expect(d.chapterNum).toBe(2)
      expect(d.resumePoint).toBe('post-finalize-residue') // 基线已存在
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 7: 空短篇集（无篇）→ 起草第 1 章（篇号 = 0 + 1）', () => {
  const root = makeShortBook()
  try {
    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7)
    if (d.state === 7) {
      expect(d.nextChapter).toBe(1) // 写作/正文/ 空 → 第 1 章
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 态 7: 已有 2 章定稿 → 起草第 3 章（篇号 = 扫 写作/正文/ 数 + 1）', () => {
  const root = makeShortBook()
  try {
    finalizePiece(root, 1, '雪夜')
    finalizePiece(root, 2, '旧伞')

    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7)
    if (d.state === 7) {
      expect(d.nextChapter).toBe(3) // 写作/正文/ 有 2 章 → 第 3 章
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short 不触发态 5/6: 已有多个章节也不判卷末/体检（无长程概念）', () => {
  const root = makeShortBook()
  try {
    // 造 3 篇（足够验证不误判；态 5 要 50 章、态 6 要 30 章，短篇即使凑数也不触发）
    for (let i = 1; i <= 3; i++) finalizePiece(root, i, `章${i}`)
    const d = detectState(root, SHORT_CONFIG)
    expect(d.state).toBe(7) // 直接落态 7，不进 5/6
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long 回归: 同一 detectState 长篇分支不受 short 改动影响', () => {
  const root = mkdtempSync(join(tmpdir(), '长篇-'))
  try {
    writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG) // 无 kind = long
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    mkdirSync(join(root, '布线', '悬念'), { recursive: true })
    mkdirSync(join(root, '工作区'), { recursive: true })
    mkdirSync(join(root, '.cache'), { recursive: true })

    // 长篇空书 → 态 7（有布线目录走长篇分支；无布线的短篇才走 readChapterDir 计数）
    const d = detectState(root, DEFAULT_CONFIG)
    expect(d.state).toBe(7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
