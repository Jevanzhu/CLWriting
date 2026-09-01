/**
 * R36-16（三十六轮）materials.ts 消费面接线回归：
 * prepareMaterials 从兼容包装 recall() 切到结构化出口 recallDetailed，truncated
 * 截断信号不再丢失——经 ragTruncated + ragNote（截断文案含全量块数）透出。
 *
 * 目标场景 ~3.5 万块未触界（RAG_CHUNK_WARN_THRESHOLD=10 万），本测试用
 * PrepareMaterialsOptions.warnThreshold 压低阈值（数据驱动、不依赖真机/海量数据）
 * 构造截断场景，验证生产消费面的逐字段行为。
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncChapter } from '../../src/cache/sync.js'
import { prepareMaterials } from '../../src/process/materials.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { writeChapter } from '../helpers/chapter.js'
import { buildIndex } from '../../src/rag/index.js'
import { enableRag } from '../../src/rag/config.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'
import type { RagConfig } from '../../src/rag/config.js'

function makeBook(): { root: string; workDir: string; db: DatabaseSync } {
  const workDir = mkdtempTracked(join(tmpdir(), 'mat-r36-'))
  const root = join(workDir, 'mybook')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '.cache'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止和解\n', 'utf-8')

  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p1',
  })

  // 定稿正文 ≥2 段 → ≥2 块（warnThreshold=1 时必然触发硬截断）
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  const meta: ChapterMeta = {
    章号: 1, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _path: '', _wordCount: 100,
  }
  writeChapter(
    join(root, '写作', '正文', '1-前章.md'),
    meta,
    '主角挥剑斩向暗影，剑光如匹练，映出密室深处的古卷。这是战斗场景的详细描写。\n\n她沉默了一会儿，说：你早就知道答案。古卷里藏着下一章的线索。\n\n风吹过回廊，烛火摇曳，远处的脚步声逐渐逼近。',
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

test('R36-16: 召回池被硬截断 → ragTruncated 透出 + ragNote 留痕（修复前信号被兼容包装丢弃）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
    const cfg: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    const bi = await buildIndex(root, cfg, 'stub-key', stubEmbed)
    expect(bi.ok).toBe(true)
    expect(bi.chunkCount).toBeGreaterThanOrEqual(2)

    // warnThreshold=1 压低阈值 → recallDetailed 硬截断（保读出序前缀 1 块）
    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root,
      workDir,
      chapterLeadIds: [],
      embedFn: stubEmbed,
      warnThreshold: 1,
    })
    // 消费面接线：截断事实透出（修复前改材料走 recall() 包装，此处恒无信号）
    expect(r.ragTruncated).toBe(true)
    expect(r.ragHitCount).toBeLessThanOrEqual(1)
    expect(r.ragNote).toContain('硬截断')
    expect(r.ragNote).toContain('块仅取前 1 块')
    // 截断未阻断主路径：召回段照常组装（保读出序前缀的 1 块命中）
    expect(r.ragUsed).toBe(true)
    const ragSection = r.sections.find((s) => s.title === 'RAG 召回')
    expect(ragSection).toEqual(expect.objectContaining({ title: 'RAG 召回' }))
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('R36-16: 未触界 → ragTruncated 缺省（信号不误报，行为与修复前一致）', async () => {
  const { root, workDir, db } = makeBook()
  try {
    enableRag(root, workDir, { endpoint: 'http://stub', model: 'stub-model', apiKey: 'stub-key' })
    const cfg: RagConfig = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }
    await buildIndex(root, cfg, 'stub-key', stubEmbed)

    const r = await prepareMaterials(db, DEFAULT_CONFIG, {
      bookRoot: root,
      workDir,
      chapterLeadIds: [],
      embedFn: stubEmbed,
    })
    expect(r.ragTruncated).toBeUndefined()
    expect(r.ragUsed).toBe(true)
  } finally {
    db.close()
    rmSync(workDir, { recursive: true, force: true })
  }
})