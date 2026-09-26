/**
 * R0916-7-P3-2（全项目源码质量与优雅度评审 P3-2）直测：tree-issues-collect 纯决策件。
 *
 * collectTreeIssuesCore 原把判定内联在 IO 交织的生成器里（圈复杂度 66），本批切出
 * 「章级条目合并 / 待落盘入列闸 / 清单折叠索引 / 定稿态派生 / 定稿态跳过」五组纯判定
 * ——本用例逐组表驱动覆盖切面分支，是这些判定的语义锚（集成锚见
 * tree-issues-async-parity / join-fold-residuals / tree-issues-epoch-fingerprint 等）。
 */
import { describe, expect, it } from 'vitest'
import {
  treeIssuesChapterEntry,
  shouldQueueChapterCacheRow,
  indexManifestByPath,
  indexEntriesByPath,
  treeChapterAggregationStatus,
  skipsTreeRedDot,
  type ChapterCacheRowSignals,
} from '../../src/check/tree-issues-collect.js'
import type { ManifestEntry } from '../../src/document/manifest.js'
import type { DocumentStatus } from '../../src/document/status.js'
import { docJoinKey } from '../../src/fs/safe-path.js'

/** 清单条目工厂（只填索引关心的字段）。 */
function entry(path: string, finalizedRevision?: string): ManifestEntry {
  return {
    id: `id:${path}`,
    nodeType: 'document',
    path,
    parentId: null,
    ...(finalizedRevision !== undefined ? { finalizedRevision } : {}),
  }
}

describe('R0916-7-P3-2 tree-issues-collect：章级条目合并', () => {
  const cases: [boolean, boolean, boolean, { hasRed: boolean; verdictRejected: boolean } | null][] = [
    // 两侧皆假且无驳回 → 不入表（「树红点只记有 issue 的 docId」契约）
    [false, false, false, null],
    [true, false, false, { hasRed: true, verdictRejected: false }],
    // verdict 驳回单独入表（章级无红也要让前端看到驳回）
    [false, true, false, { hasRed: false, verdictRejected: true }],
    // 账本全书性红只在展示层合并：入表的 hasRed 取并集，verdictRejected 原样
    [false, false, true, { hasRed: true, verdictRejected: false }],
    [true, true, true, { hasRed: true, verdictRejected: true }],
  ]
  it.each(cases)('hasRed=%s verdictRejected=%s leadsBookRed=%s → %o', (hasRed, verdictRejected, leadsBookRed, expected) => {
    expect(treeIssuesChapterEntry(hasRed, verdictRejected, leadsBookRed)).toEqual(expected)
  })
})

describe('R0916-7-P3-2 tree-issues-collect：待落盘入列闸', () => {
  const ALL_ON: ChapterCacheRowSignals = {
    checkFailed: false,
    cacheEnabled: true,
    hasDb: true,
    hasEpochBaseline: true,
  }
  const cases: [string, ChapterCacheRowSignals, boolean][] = [
    ['四闸全真 → 入列', ALL_ON, true],
    // 机检失败落行 = 把「未检出」固化成假阴性，恒不入列
    ['本轮机检失败 → 不列', { ...ALL_ON, checkFailed: true }, false],
    ['章级缓存不可用（表缺席/纪元同步失败）→ 不列', { ...ALL_ON, cacheEnabled: false }, false],
    ['无库句柄 → 不列', { ...ALL_ON, hasDb: false }, false],
    // 纪元基线缺席 = 并发下可能按他进程新纪元误读旧行，一律按 miss
    ['纪元基线缺席 → 不列', { ...ALL_ON, hasEpochBaseline: false }, false],
  ]
  it.each(cases)('%s', (_name, signals, expected) => {
    expect(shouldQueueChapterCacheRow(signals)).toBe(expected)
  })
})

describe('R0916-7-P3-2 tree-issues-collect：清单折叠索引', () => {
  const manifest = new Map<string, ManifestEntry>([
    ['doc1', entry('写作/正文/第1章.md', 'sha256:aaa')],
    ['doc2', entry('写作/正文/第2章.md')],
  ])

  it('键 = docJoinKey(登记路径)（查询侧同键可命中）', () => {
    const idx = indexManifestByPath(manifest)
    expect([...idx.keys()].sort()).toEqual([docJoinKey('写作/正文/第1章.md'), docJoinKey('写作/正文/第2章.md')].sort())
    expect(idx.get(docJoinKey('写作/正文/第1章.md'))).toBe('doc1')
    expect(idx.get(docJoinKey('写作/正文/第9章.md'))).toBeUndefined()
  })

  it('条目索引保留整条（finalizedRevision 等在位）且与 docId 索引同键空间', () => {
    const byEntry = indexEntriesByPath(manifest)
    const byDocId = indexManifestByPath(manifest)
    expect([...byEntry.keys()].sort()).toEqual([...byDocId.keys()].sort())
    // 定稿基线不得在索引面丢失（定稿态跳过判定依赖本字段）
    expect(byEntry.get(docJoinKey('写作/正文/第1章.md'))?.finalizedRevision).toBe('sha256:aaa')
    expect(byEntry.get(docJoinKey('写作/正文/第2章.md'))?.finalizedRevision).toBeUndefined()
  })

  it('空清单 → 空索引（无路径可索引）', () => {
    expect(indexManifestByPath(new Map()).size).toBe(0)
    expect(indexEntriesByPath(new Map()).size).toBe(0)
  })
})

describe('R0916-7-P3-2 tree-issues-collect：定稿态派生（惰性探针）', () => {
  it('base=final 且探针真 → published', () => {
    expect(treeChapterAggregationStatus('final', () => true)).toBe('published')
  })

  it('base=final 且探针假 → 保持 final', () => {
    expect(treeChapterAggregationStatus('final', () => false)).toBe('final')
  })

  it('base 非 final 恒不问探针（final 以外无 published 面）', () => {
    const bases: DocumentStatus[] = ['idea', 'draft', 'revision', 'published', 'archived']
    for (const base of bases) {
      let calls = 0
      const got = treeChapterAggregationStatus(base, () => {
        calls++
        return true
      })
      expect(got, `base=${base}`).toBe(base)
      expect(calls, `base=${base} 不应探 published`).toBe(0)
    }
  })
})

describe('R0916-7-P3-2 tree-issues-collect：定稿态跳过', () => {
  const cases: [DocumentStatus, boolean][] = [
    ['final', true],
    ['published', true],
    ['idea', false],
    ['draft', false],
    ['revision', false],
    ['archived', false],
  ]
  it.each(cases)('status=%s → 跳过红点=%s', (status, expected) => {
    expect(skipsTreeRedDot(status)).toBe(expected)
  })
})
