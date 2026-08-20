/**
 * H-1（二轮复审）回归：learn 收割只认定稿章——草稿/在写章混入候选池会污染文风基准。
 * 判定与导出 V-P2-2 同一函数（manifest.finalizedPathSet）；旧书无清单 → 全量（降级一致）。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { learnFromBook } from '../../src/learn/index.js'

const QUALIFYING_BODY =
  '林远踏出山门，暮色四合，青石阶尽头的灯火次第亮起。玉佩在胸前微微发烫，像一颗不肯安分的心。他抬手覆上，那温度便缓缓沉下去。\n\n他忽然感到一阵锥心之痛，仿佛有旧事在血里翻身。'

function makeBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'learn-final-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\n', 'utf-8')
  writeFileSync(
    join(root, '写作', '正文', '0001-草稿章.md'),
    `---\n章号: 1\n标题: 草稿章\n---\n${QUALIFYING_BODY}`,
    'utf-8',
  )
  writeFileSync(
    join(root, '写作', '正文', '0002-定稿章.md'),
    `---\n章号: 2\n标题: 定稿章\n---\n${QUALIFYING_BODY}`,
    'utf-8',
  )
  return root
}

test('H-1: 无清单（旧书降级）→ 全量收割（草稿也收，与导出口径一致）', () => {
  const root = makeBook()
  try {
    const r = learnFromBook(root)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sampleCount).toBeGreaterThan(0)
      expect(r.skippedDrafts).toBe(0)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H-1: 有清单 → 草稿章被跳过，只有定稿章进候选池', () => {
  const root = makeBook()
  try {
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      [
        JSON.stringify({ version: 1, type: 'header' }),
        JSON.stringify({ id: 'd1', nodeType: 'document', path: '写作/正文/0001-草稿章.md', parentId: null }),
        JSON.stringify({
          id: 'd2',
          nodeType: 'document',
          path: '写作/正文/0002-定稿章.md',
          parentId: null,
          finalizedRevision: 'sha256:x',
        }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = learnFromBook(root)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.sampleCount).toBeGreaterThan(0)
      expect(r.skippedDrafts).toBe(1)
      // 候选全部来自定稿章（章号 2），草稿章（章号 1）零候选
      for (const s of r.samples ?? []) expect(s.章号).toBe(2)
      for (const q of r.quotes ?? []) expect(q.章号).toBe(2)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H-1: 全部是草稿 → 没有定稿正文可收割（400 口径的内核来源）', () => {
  const root = makeBook()
  try {
    writeFileSync(
      join(root, '项目', '文档清单.jsonl'),
      [
        JSON.stringify({ version: 1, type: 'header' }),
        JSON.stringify({ id: 'd1', nodeType: 'document', path: '写作/正文/0001-草稿章.md', parentId: null }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = learnFromBook(root)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/没有定稿正文/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
