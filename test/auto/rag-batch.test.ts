/**
 * M7 R1 接缝：auto 连写层接入 RAG 召回的集成测试。
 *
 * 验证编排层把 tools 注入 produce 回调，宿主在内 await tools.prepareMaterials
 * 能拿到含「RAG 召回」段的备料（命中路径用桩 embed）。
 */

import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { doAutoBatch, type ChapterProduction } from '../../src/auto/batch.js'
import { buildIndex } from '../../src/rag/index.js'
import { enableRag } from '../../src/rag/config.js'
import { writeChapter } from '../../src/format/chapters.js'
import { prepareMaterials } from '../../src/process/materials.js'
import { rebuild } from '../../src/cache/rebuild.js'
import { DatabaseSync } from 'node:sqlite'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RagConfig } from '../../src/rag/config.js'

function stubEmbed(_ep: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const code = t.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

test('auto 连写: produce 内 await tools.prepareMaterials 拿到含 RAG 召回的备料', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'auto-rag-wd-'))
  const root = join(workDir, 'mybook')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '卷纲', 'v1.md'), '纲', 'utf-8')
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止和解\n', 'utf-8')
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })

  // 写 1 章定稿正文（供 RAG 建索引 + 召回）
  const meta: ChapterMeta = {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _path: '', _wordCount: 100,
  }
  writeChapter(
    join(root, '定稿', '正文', '0001-前章.md'),
    meta,
    '主角挥剑斩向暗影，剑光映出密室古卷。这是战斗场景的详细描写段落。',
  )
  execSync('git add -A && git commit -m "ch:0001 前章"', { cwd: root, stdio: 'pipe' })

  // 启用 RAG + 建索引（桩 embed）
  enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
  const cfg: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
  await buildIndex(root, cfg, 'stub-key', stubEmbed)

  // produce 内 await tools.prepareMaterials，捕获备料状态
  let capturedRagUsed = false
  let capturedRagHitCount = 0
  let capturedHasRagSection = false
  const produce = async ({ chapter, tools }: { chapter: number; tools: any }): Promise<ChapterProduction> => {
    const m = await tools.prepareMaterials([], '主角挥剑')
    capturedRagUsed = m.ragUsed
    capturedRagHitCount = m.ragHitCount
    capturedHasRagSection = m.text.includes('RAG 召回')
    return {
      title: `第${chapter}章`, outline: `纲${chapter}`,
      body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第${chapter}章正文。\n`,
      chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
    }
  }

  // 注意：默认 toolsFactory 用真 embed（fetch http://stub 失败 → 召回空 → 降级）。
  // 为验证「命中」路径，注入桩 toolsFactory 让 prepareMaterials 用桩 embed。
  const r = await doAutoBatch({
    bookRoot: root, targetCount: 1, produce,
    toolsFactory: ({ config, bookRoot, workDir }) => ({
      prepareMaterials: async (leadIds: string[], query?: string) => {
        const cachePath = join(bookRoot, '.cache', 'index.db')
        rebuild(bookRoot, cachePath)
        const db = new DatabaseSync(cachePath)
        try {
          const res = await prepareMaterials(db, config, {
            bookRoot, workDir, chapterLeadIds: leadIds,
            ...(query ? { query } : {}),
            embedFn: stubEmbed,
          })
          return { text: res.text, ragUsed: res.ragUsed, ragHitCount: res.ragHitCount }
        } finally {
          db.close()
        }
      },
    }),
  })

  expect(r.ok).toBe(true)
  // produce 内捕获到含召回的备料
  expect(capturedRagUsed).toBe(true)
  expect(capturedRagHitCount).toBeGreaterThan(0)
  expect(capturedHasRagSection).toBe(true)

  rmSync(workDir, { recursive: true, force: true })
})

test('auto 连写: 未配 RAG 时 tools.prepareMaterials 降级（ragUsed=false 不崩）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-norag-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '卷纲', 'v1.md'), '纲', 'utf-8')
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止和解\n', 'utf-8')
  mkdirSync(join(root, '.cache'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })

  let captured: { ragUsed: boolean; ragHitCount: number; len: number } | null = null
  const produce = async ({ chapter, tools }: { chapter: number; tools: any }): Promise<ChapterProduction> => {
    const m = await tools.prepareMaterials([])
    captured = { ragUsed: m.ragUsed, ragHitCount: m.ragHitCount, len: m.text.length }
    return {
      title: `第${chapter}章`, outline: `纲${chapter}`,
      body: `---\n章号: ${chapter}\n标题: 第${chapter}章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n\n第${chapter}章正文。\n`,
      chapter: { 章号: chapter, 标题: `第${chapter}章`, 钩子类型: '悬念钩', 钩子强弱: '强', 情绪定位: '铺垫' },
    }
  }

  const r = await doAutoBatch({ bookRoot: root, targetCount: 1, produce })
  expect(r.ok).toBe(true)
  // 未配 RAG → 降级，但仍能拿到备料（含近况/文风铁律刚需段）
  expect(captured).not.toBeNull()
  expect(captured!.ragUsed).toBe(false)
  expect(captured!.ragHitCount).toBe(0)
  expect(captured!.len).toBeGreaterThan(0)

  rmSync(root, { recursive: true, force: true })
})
