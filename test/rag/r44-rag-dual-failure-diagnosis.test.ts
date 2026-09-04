/**
 * R44-21（四十四轮批 B5）回归：RAG 建索引读失败与 embed 失败叠加时双成因并列。
 *
 * 缺陷：readFailAt 非 null 且 commitIndexBatch 失败（embed 端点挂/维度失配等）时
 * 直接透传 embed 失败信封——「第 N 章正文读取失败」被丢弃，作者只见 embed 报错，
 * 修好端点重跑又撞读失败，第二成因无从预期。
 *
 * 修复：error 文案并列两成因（读失败章号 + embed 失败原文案拼接）；ok/章块计数
 * 语义与自愈游标纪律不变（游标仍不越失败章，恢复后重跑自动补齐）。
 *
 * 读失败注入与 test/rag/index.test.ts RB-IF-P1-3 同款：第 1 次读取放行
 * （readChapterDir 扫描建 chapters 列表），第 2 次起失败（模拟建索引中途文件被占用）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildIndex } from '../../src/rag/index.js'
import { openRagDb, getRagMeta } from '../../src/rag/store.js'
import { writeChapter } from '../helpers/chapter.js'
import type { ChapterMeta } from '../../src/format/types.js'
import type { EmbedResult } from '../../src/rag/embed.js'

/** 读失败注入开关（vi.mock 工厂提升到文件顶部，运行时状态经 vi.hoisted 传递） */
const readFailState = vi.hoisted(() => ({ path: null as string | null, seen: 0 }))
vi.mock('../../src/format/frontmatter.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/format/frontmatter.js')>()
  return {
    ...orig,
    readFile: (fp: string) => {
      if (readFailState.path !== null && fp === readFailState.path) {
        readFailState.seen++
        if (readFailState.seen >= 2) {
          return { ok: false as const, error: { file: fp, line: 0, message: '模拟文件占用' } }
        }
      }
      return orig.readFile(fp)
    },
  }
})

describe('R44-21: 读失败 × embed 失败叠加诊断', () => {
  let bookRoot: string
  const config = { enabled: true, endpoint: 'http://stub', model: 'stub-model' }

  beforeEach(() => {
    bookRoot = join(tmpdir(), `rag-r44-21-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
    readFailState.path = null
    readFailState.seen = 0
    for (const n of [1, 2, 3, 4]) addChapter(n)
  })

  afterEach(() => {
    readFailState.path = null
    readFailState.seen = 0
    rmSync(bookRoot, { recursive: true, force: true })
  })

  function addChapter(n: number): void {
    const meta: ChapterMeta = {
      章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫',
      _path: '', _wordCount: 100,
    }
    writeChapter(join(bookRoot, '写作', '正文', `${n}-第${n}章.md`), meta, `第${n}章的正文段落内容，这是一个战斗场景，主角挥剑战斗。`)
  }

  function goodEmbed(_e: string, _m: string, _k: string, texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(
      texts.map((t) => {
        const norm = 1 / ((t.charCodeAt(0) || 1) + 1)
        return [norm, norm * 0.5, norm * 0.3]
      }),
    )
  }

  function failEmbed(_e: string, _m: string, _k: string, _texts: string[]): Promise<EmbedResult> {
    return Promise.resolve(null)
  }

  function cursor(): string | null {
    const db = openRagDb(bookRoot)
    try {
      return getRagMeta(db, 'indexed_max_chapter')
    } finally {
      db.close()
    }
  }

  function hasFingerprint(n: number): boolean {
    const db = openRagDb(bookRoot)
    try {
      return getRagMeta(db, `chapter_hash:${n}`) !== null
    } finally {
      db.close()
    }
  }

  it('双失败叠加 → error 同时含读失败章号与 embed 失败原文案；计数/游标语义不变', async () => {
    readFailState.path = join(bookRoot, '写作', '正文', '3-第3章.md')

    const r = await buildIndex(bookRoot, config, 'key', failEmbed)

    expect(r.ok).toBe(false)
    // 修复点：读失败成因不再被 embed 失败信封丢弃
    expect(r.error).toContain('第 3 章')
    expect(r.error).toContain('读取失败')
    // embed 失败原文案整段保留（拼接而非替换）
    expect(r.error).toContain('embedding 端点调用失败（已降级，未阻断主路径）')
    // 计数语义沿用 committed（首批即失败零续传）
    expect(r.chunkCount).toBe(0)
    expect(r.chapterCount).toBe(0)
    // 自愈游标纪律不变：游标不越失败章（本轮零章提交，游标未动）
    expect(cursor()).toBeNull()
    expect(hasFingerprint(3)).toBe(false)
  })

  it('单成因形态不回归·纯读失败（embed 正常）→ 仅读失败文案 + 部分成功计数', async () => {
    readFailState.path = join(bookRoot, '写作', '正文', '3-第3章.md')

    const r = await buildIndex(bookRoot, config, 'key', goodEmbed)

    expect(r.ok).toBe(false)
    expect(r.error).toContain('第 3 章')
    expect(r.error).toContain('读取失败')
    expect(r.error).not.toContain('embedding') // 不混入另一成因
    expect(r.chunkCount).toBeGreaterThan(0) // 部分成功口径照旧（1-2 章入库）
    expect(cursor()).toBe('2')
    expect(hasFingerprint(3)).toBe(false)
  })

  it('单成因形态不回归·纯 embed 失败（无读失败）→ 仅 embed 失败文案', async () => {
    const r = await buildIndex(bookRoot, config, 'key', failEmbed)

    expect(r.ok).toBe(false)
    expect(r.error).toContain('embedding 端点调用失败（已降级，未阻断主路径）')
    expect(r.error).not.toContain('读取失败') // 不混入另一成因
    expect(cursor()).toBeNull()
  })

  it('双失败后恢复重跑 → 自动补齐全书（自愈纪律不受双成因文案影响）', async () => {
    readFailState.path = join(bookRoot, '写作', '正文', '3-第3章.md')
    const r1 = await buildIndex(bookRoot, config, 'key', failEmbed)
    expect(r1.ok).toBe(false)

    // 双双恢复（占用解除 + 端点修好）→ 重跑补齐 1-4 章，指纹齐全
    readFailState.path = null
    readFailState.seen = 0
    const r2 = await buildIndex(bookRoot, config, 'key', goodEmbed)
    expect(r2.ok).toBe(true)
    expect(r2.chapterCount).toBe(4)
    expect(cursor()).toBe('4')
    for (const n of [1, 2, 3, 4]) expect(hasFingerprint(n)).toBe(true)
  })
})
