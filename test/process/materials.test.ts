/**
 * 备料编排测试 —— M7 #37 R1 接缝真正接入（prepareMaterials：recall → prepare）。
 *
 * 验收点：
 * - 未配 RAG → 行为逐字节不变（与 prepare() 直接调用一致）
 * - 已配 RAG + key → 命中召回 → 备料含「RAG 召回」段
 * - 已配 RAG 但无 key → 降级（无召回段，ragNote 标注）
 * - 已配 RAG 但召回无命中 → 降级（无召回段）
 *
 * 桩 embed 不联网：把文本首字符 charCode 归一化成 3 维向量（确定性）。
 */

import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncChapter } from '../../src/cache/sync.js'
import { prepareMaterials } from '../../src/process/materials.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeChapter } from '../../src/format/chapters.js'
import { buildIndex } from '../../src/rag/index.js'
import { enableRag } from '../../src/rag/config.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RagConfig } from '../../src/rag/config.js'

/** 建一本带 .cache + 文风铁律 + 1 章定稿正文的测试书。 */
function makeBook(): { root: string; workDir: string; db: DatabaseSync } {
  const workDir = mkdtempSync(join(tmpdir(), 'mat-wd-'))
  const root = join(workDir, 'mybook')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '.cache'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止和解\n', 'utf-8')
  mkdirSync(join(root, '文风', '样章库', '对话'), { recursive: true })
  writeFileSync(
    join(root, '文风', '样章库', '对话', '对话-001.md'),
    '---\n场景: 对话\n来源: 作者原作\n技法指令: 学它的留白\n---\n她沉默了一会儿，说：你早就知道。',
    'utf-8',
  )

  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p1',
  })

  // 写 1 章定稿正文（供 RAG 建索引 + 召回后精准读取切片）
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  const meta: ChapterMeta = {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _path: '', _wordCount: 100,
  }
  writeChapter(
    join(root, '定稿', '正文', '1-前章.md'),
    meta,
    '主角挥剑斩向暗影，剑光如匹练，映出密室深处的古卷。这是战斗场景的详细描写。',
  )
  return { root, workDir, db }
}

/** 桩 embed：确定性，不联网。 */
function stubEmbed(_ep: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
  return Promise.resolve(
    texts.map((t) => {
      const code = t.charCodeAt(0) || 1
      const norm = 1 / (code + 1)
      return [norm, norm * 0.5, norm * 0.3]
    }),
  )
}

test('未配 RAG → prepareMaterials 行为与 prepare 逐字节一致', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 未配 RAG（默认 book.yaml 无 rag 段）
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [],
    })
    expect(r.ragUsed).toBe(false)
    expect(r.ragHitCount).toBe(0)
    // 无 RAG 段
    expect(r.sections.find((s) => s.title === 'RAG 召回')).toBeUndefined()
    expect(r.ragNote).toBeUndefined() // 未配不算降级
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('prepareMaterials: 透传 sampleScene 给文风样章', async () => {
  const { root, workDir, db } = makeBook()
  try {
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], sampleScene: '对话',
    })
    const styleSection = r.sections.find((s) => s.title === '文风样章')
    expect(styleSection).toBeDefined()
    expect(styleSection!.content).toContain('学它的留白')
    expect(styleSection!.content).toContain('你早就知道')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('已配 RAG + key + 命中 → 备料含「RAG 召回」段', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 启用 RAG（非密入 book.yaml + key 落 .clwriting/rag.secret）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
    // 先建索引（用桩 embed 注入 buildIndex）
    const cfg: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(root, cfg, 'stub-key', stubEmbed)

    // prepareMaterials 注入同一个桩 embedFn，让 recall 用确定性向量命中
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [], embedFn: stubEmbed,
    })
    expect(r.ragUsed).toBe(true)
    expect(r.ragHitCount).toBeGreaterThan(0)
    // 备料含 RAG 召回段
    const ragSection = r.sections.find((s) => s.title === 'RAG 召回')
    expect(ragSection).toBeDefined()
    expect(ragSection!.flexibleRank).toBe(5)
    // 召回内容引用了第1章正文（精准读取切片）
    expect(ragSection!.content).toContain('第1章')
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('已配 RAG 但无 key → 降级（无召回段，ragNote 标注）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 启用 RAG 但不落 key（useEnv 模式 + 不设环境变量）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', useEnv: true })
    // 确保无环境变量也无 secret 文件
    delete process.env.CLWRITING_RAG_API_KEY
    expect(existsSync(join(workDir, '.clwriting', 'rag.secret'))).toBe(false)

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [],
    })
    expect(r.ragUsed).toBe(false)
    expect(r.ragNote).toContain('api_key')
    expect(r.sections.find((s) => s.title === 'RAG 召回')).toBeUndefined()
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('降级不崩主路径：备料文本仍含刚需段（近况/文风铁律）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    // 已配 RAG 但无 key（降级路径）
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', useEnv: true })
    delete process.env.CLWRITING_RAG_API_KEY

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root, workDir, chapterLeadIds: [],
    })
    // 刚需段必须在（降级只影响 RAG 召回段）
    expect(r.sections.find((s) => s.title === '近况')).toBeDefined()
    expect(r.sections.find((s) => s.title === '文风铁律')).toBeDefined()
    expect(r.text.length).toBeGreaterThan(0)
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})
