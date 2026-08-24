/**
 * 新书冷启动守护（阶段 23 批 3：迭代建议清偿·讨论稿建议 9）。
 *
 * 回答「用户第一天」：空书/仅一章/无语料/无摘要/无样章时——
 * ①机检（树红点聚合）零误报红点、不炸；
 * ②RAG 空语料走设计内降级（无定稿正文 → 明确错误形状；未启用 → 空召回），不炸；
 * ③首稿 prompt 组装（buildDraftPrompt）各层全空可组装，且铁律①「模型可见⟺已记录」
 *   双向成立——files 清单里每个源都真实存在于书内。
 *
 * 造书走真实 scaffoldBookRepo（非手拼目录）——守护的就是脚手架产物的第一天行为。
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldBookRepo } from '../../src/install/scaffold.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { buildIndex, recall } from '../../src/rag/index.js'
import { buildDraftPrompt } from '../../src/process/draft-pipeline.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** embed 桩：确定性常向量，不联网（rag scale 同款注入点） */
function stubEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(texts.map(() => [1, 0, 0]))
}

function freshBook(kind: 'long' | 'short'): string {
  const root = mkdtempSync(join(tmpdir(), `cold-start-${kind}-`))
  scaffoldBookRepo(root, {
    name: '冷启动测试书',
    genre: '仙侠',
    leadsEnabled: [],
    kind,
  })
  return root
}

const noVerdict = (_docId: string) => undefined

describe('新书冷启动：空书/仅一章/空语料/首稿链路', () => {
  it('长篇空书：树红点聚合零红点不炸', () => {
    const root = freshBook('long')
    try {
      const r = collectTreeIssues(root, noVerdict)
      expect(r.issues).toEqual({}) // 第一天：无任何误报红点
      expect(r.rebuildFailed).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('短篇空书：树红点聚合零红点不炸', () => {
    const root = freshBook('short')
    try {
      const r = collectTreeIssues(root, noVerdict)
      expect(r.issues).toEqual({})
      expect(r.rebuildFailed).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('仅一章干净正文：零误报红点（写第一章的当天）', () => {
    const root = freshBook('long')
    try {
      const rel = '写作/正文/001-第1章.md'
      const meta: ChapterMeta = {
        章号: 1, 标题: '第1章', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
        _path: '', _wordCount: 0,
      }
      writeChapter(join(root, rel), meta, '少年背起行囊走出山门，长街灯火次第亮起。\n')
      const m = readManifest(join(root, '项目', '文档清单.jsonl'))
      upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: rel, parentId: null })
      writeManifest(join(root, '项目', '文档清单.jsonl'), m)

      const r = collectTreeIssues(root, noVerdict)
      expect(r.issues).toEqual({}) // 干净正文不得有误报
      expect(r.rebuildFailed).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('RAG 空语料：无定稿正文 → 设计内错误形状；未启用 → 空召回', async () => {
    const root = freshBook('long')
    try {
      const config = { enabled: true, endpoint: 'http://stub', model: 'bench-model' }
      const built = await buildIndex(root, config, 'stub-key', stubEmbed)
      expect(built.ok).toBe(false) // 不炸：明确的设计内降级形状
      expect(built.error).toContain('没有定稿正文可索引')
      expect(built.chapterCount).toBe(0)

      const hits = await recall(root, { enabled: false, endpoint: '', model: '' }, 'stub-key', '随便问')
      expect(hits).toEqual([]) // 未启用 → 空召回降级（红线：不崩）
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('首稿链路：各层全空可组装，files 清单源全部真实存在（铁律①双向）', () => {
    const root = freshBook('long')
    try {
      const r = buildDraftPrompt(root, 1, 'long')
      expect(typeof r.prompt).toBe('string')
      expect(r.prompt.length).toBeGreaterThan(0)
      // 铁律①双向：files 登记的每个源都真实存在于书内（可见⟺已记录——已记录 ⟹ 可见）
      for (const rel of r.files) {
        expect(existsSync(join(root, rel)), `files 登记了不存在的源：${rel}`).toBe(true)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
