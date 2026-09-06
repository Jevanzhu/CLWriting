/**
 * R53-E-1（五十三轮）回归：账本全书性红项写前纪元终核（R70-14 章级行同款口径）。
 *
 * 缺陷现场：collectTreeIssues 内 leadsFp 在聚合开头计算（computeLeadsBookFp），
 * writeLeadsBookRed 在 checkLeadsBookItems 全账本扫描之后落盘——窗口内外部编辑器/
 * 第二进程改纪元输入（大纲/章纲/布线/正文）时，旧结果按新输入视角陈旧落表（该周期
 * 红点错、下轮自愈）。章级行自 R70-14 起有写前复核，此处漏同款。
 *
 * 修复后：写前复核 leadsFp 未变才落缓存；漂移 → 本轮不固化（返回值照常，下轮重算）。
 *
 * 手法：vi.mock tree-issues-cache 只覆 computeLeadsBookFp（默认委托真实实现），
 * 用 mockReturnValueOnce 精确控制「聚合头 / 写前复核」两次调用的返回值制造漂移。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../src/check/tree-issues-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/tree-issues-cache.js')>()
  return { ...actual, computeLeadsBookFp: vi.fn((...a: Parameters<typeof actual.computeLeadsBookFp>) => actual.computeLeadsBookFp(...a)) }
})

import { collectTreeIssues } from '../../src/check/run.js'
import { computeLeadsBookFp } from '../../src/check/tree-issues-cache.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const fpMock = vi.mocked(computeLeadsBookFp)

beforeEach(() => {
  // 只清调用记录：Once 队列耗尽后回落默认委托（真实实现），不污染后续用例
  fpMock.mockClear()
})

/** 造最小书：1 草稿章 + 悬念-001 履历第 2 章（正文缺失 → lead-evidence-unverifiable，
 *  但全书性红项判定与缓存写路径与完整书同链路，足够锁本修复的落表行为） */
function makeBook(): { root: string; docId1: string } {
  const root = mkdtempTracked(join(tmpdir(), 'r53-e1-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-密室之主.md'),
    '---\n编号: 悬念-001\n标题: 密室之主\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第2章 埋下：「青铜灯」\n',
    'utf-8',
  )
  const rel = '写作/正文/001-第一章.md'
  writeFileSync(
    join(root, rel),
    '---\n章号: 1\n标题: 第一章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第一章正文，山门外落了整夜的雨。\n',
    'utf-8',
  )
  const m = readManifest(join(root, '项目', '文档清单.jsonl'))
  const entry: ManifestEntry = { id: generateDocId(), nodeType: 'document', path: rel, parentId: null }
  upsertEntry(m, entry)
  writeManifest(join(root, '项目', '文档清单.jsonl'), m)
  return { root, docId1: entry.id }
}

function readLeadsBookRows(root: string): Array<{ key: string; value: string }> {
  const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
  try {
    return db.prepare(`SELECT key, value FROM tree_issues_meta WHERE key LIKE 'leads_book%'`).all() as Array<{
      key: string
      value: string
    }>
  } finally {
    db.close()
  }
}

describe('R53-E-1：leads_book 写前纪元终核', () => {
  it('写前复核漂移（聚合头 fp-A → 写前 fp-B）→ 本轮不落缓存，红点照常返回；去漂移后下轮自愈落表', () => {
    const { root, docId1 } = makeBook()
    try {
      fpMock.mockReturnValueOnce('fp-A').mockReturnValueOnce('fp-B') // 头遍 A、写前复核 B → 漂移
      const first = collectTreeIssues(root, () => undefined)
      // 本轮返回值不回滚（R70-14 口径：单请求周期陈旧可接受，只拦固化）
      expect(first.issues[docId1]?.hasRed).toBe(true)
      // 核心断言：漂移轮零固化（修复前此处会落 leads_book_fp=fp-A / leads_book_red=1）
      expect(readLeadsBookRows(root)).toEqual([])

      // 去漂移（Once 队列耗尽回落真实 fp）→ 下轮重算并正常落表（自愈）
      const second = collectTreeIssues(root, () => undefined)
      expect(second.issues[docId1]?.hasRed).toBe(true)
      const rows = readLeadsBookRows(root)
      expect(rows.map((r) => r.key)).toContain('leads_book_fp')
      expect(rows.map((r) => r.key)).toContain('leads_book_red')
      // 落表后再下一轮：同 fp 命中缓存（零重算路径不受影响）
      const third = collectTreeIssues(root, () => undefined)
      expect(third.issues[docId1]?.hasRed).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('写前复核同值 → 照常落缓存（等值分支不误伤正常路径）', () => {
    const { root, docId1 } = makeBook()
    try {
      fpMock.mockReturnValueOnce('fp-S').mockReturnValueOnce('fp-S') // 头遍与写前同值
      const r = collectTreeIssues(root, () => undefined)
      expect(r.issues[docId1]?.hasRed).toBe(true)
      const rows = readLeadsBookRows(root)
      expect(rows.find((x) => x.key === 'leads_book_fp')?.value).toBe('fp-S')
      expect(rows.find((x) => x.key === 'leads_book_red')?.value).toBe('1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
