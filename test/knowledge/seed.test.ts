/**
 * 书级知识层播种与升级(统一批)—— src/knowledge/seed.ts 单测。
 *
 * 锚定对外可观察行为:
 * 1) 建书播种:随包语料按要求铺进书根 知识层/(跳非语料项,幂等,已存在不覆盖);
 * 2) 升级不覆盖用户改动:哈希命中历史表(=未改动的旧版拷贝)→ 升级为当前随包;
 *    哈希不命中(=作者改过)→ 原样保留;
 * 3) 随包新增篇 → 补播;随包缺失/读失败 → 逐篇容错不拖死整轮。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { seedBookKnowledge, seedKnowledgeOnBookCreate, listBundledSeedRels } from '../../src/knowledge/seed.js'

let dir: string
let prevResourcesDir: string | undefined

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-seed-'))
  prevResourcesDir = process.env['CLWRITING_RESOURCES_DIR']
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (prevResourcesDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = prevResourcesDir
})

/** 造受限随包资源根:knowledge/<rel> 写正文 + versions 表(rel → 历史哈希)。 */
function stubBundled(files: Record<string, string>, versions: Record<string, string[]>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, 'knowledge', ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'knowledge', 'versions.json'), JSON.stringify(versions, null, 2))
  process.env['CLWRITING_RESOURCES_DIR'] = dir
}

describe('建书播种(seedKnowledgeOnBookCreate / seedBookKnowledge seedOnly)', () => {
  it('随包语料铺进书根 知识层/,非语料项(README/versions/许可)不铺', async () => {
    stubBundled(
      { '追读力/章节钩子速查.md': '钩子正文。', '方法论/人物与对话技法速查.md': '人物正文。' },
      { '追读力/章节钩子速查.md': [], '方法论/人物与对话技法速查.md': [] },
    )
    const bookRoot = join(dir, 'book')
    mkdirSync(bookRoot, { recursive: true })
    seedKnowledgeOnBookCreate(bookRoot)
    expect(existsSync(join(bookRoot, '知识层', '追读力', '章节钩子速查.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '知识层', '方法论', '人物与对话技法速查.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '知识层', 'versions.json'))).toBe(false)
    expect(existsSync(join(bookRoot, '知识层', 'README.md'))).toBe(false)
  })

  it('幂等:重复播种不覆盖已存在的书级篇(作者改动安全)', () => {
    stubBundled({ '追读力/章节钩子速查.md': '随包原版。' }, { '追读力/章节钩子速查.md': [] })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '作者手改版。')
    const r = seedBookKnowledge(bookRoot, { seedOnly: true })
    expect(r.seeded).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('作者手改版。')
  })
})

describe('升级不覆盖用户改动', () => {
  it('未改动的旧版拷贝(哈希命中历史表)→ 升级为当前随包', async () => {
    const oldBody = '旧版正文。'
    const newBody = '新版正文。'
    // 造随包:当前为新版,历史表含旧版哈希
    mkdirSync(join(dir, 'knowledge', '追读力'), { recursive: true })
    const bundledAbs = join(dir, 'knowledge', '追读力', '章节钩子速查.md')
    writeFileSync(bundledAbs, newBody)
    // 先算旧版哈希(临时文件)
    const tmpOld = join(dir, 'old.bin')
    writeFileSync(tmpOld, oldBody)
    const { hashBytes } = await import('../../src/fs/hash.js')
    const oldH = hashBytes(readFileSync(tmpOld))
    const newH = hashBytes(readFileSync(bundledAbs))
    writeFileSync(
      join(dir, 'knowledge', 'versions.json'),
      JSON.stringify({ '追读力/章节钩子速查.md': [oldH, newH] }, null, 2),
    )
    process.env['CLWRITING_RESOURCES_DIR'] = dir

    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, oldBody) // 书级 = 未改动的旧版拷贝
    const r = seedBookKnowledge(bookRoot)
    expect(r.upgraded).toEqual(['追读力/章节钩子速查.md'])
    expect(readFileSync(dst, 'utf-8')).toBe(newBody)
  })

  it('作者改过的篇(哈希不在历史表)→ 原样保留', async () => {
    const newBody = '随包新版。'
    mkdirSync(join(dir, 'knowledge', '追读力'), { recursive: true })
    const bundledAbs = join(dir, 'knowledge', '追读力', '章节钩子速查.md')
    writeFileSync(bundledAbs, newBody)
    const { hashBytes } = await import('../../src/fs/hash.js')
    writeFileSync(
      join(dir, 'knowledge', 'versions.json'),
      JSON.stringify({ '追读力/章节钩子速查.md': [hashBytes(readFileSync(bundledAbs))] }, null, 2),
    )
    process.env['CLWRITING_RESOURCES_DIR'] = dir

    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '作者大改过的正文。') // 哈希不在历史表
    const r = seedBookKnowledge(bookRoot)
    expect(r.upgraded).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('作者大改过的正文。')
  })

  it('无历史表条目 → 保守不覆盖(即便书级与随包不同)', () => {
    // versions 表里没有该 rel(如新篇尚未登记历史哈希)——无从判定书级副本是
    // 旧版原样拷贝还是作者改过,宁可留旧也不动(误覆盖会毁掉作者的写作口径)
    stubBundled({ '追读力/章节钩子速查.md': '随包新版。' }, {})
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '书级旧版(无从判定是否作者改过)。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.upgraded).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('书级旧版(无从判定是否作者改过)。')
  })

  it('随包新增篇 → 补播(书级原本无此 rel)', () => {
    stubBundled({ '追读力/新篇.md': '新篇正文。' }, { '追读力/新篇.md': [] })
    const bookRoot = join(dir, 'book')
    mkdirSync(bookRoot, { recursive: true })
    const r = seedBookKnowledge(bookRoot)
    expect(r.seeded).toContain('追读力/新篇.md')
    expect(existsSync(join(bookRoot, '知识层', '追读力', '新篇.md'))).toBe(true)
  })
})

describe('随包缺失容错', () => {
  it('随包 knowledge/ 目录缺失 → 空报告不抛', () => {
    process.env['CLWRITING_RESOURCES_DIR'] = dir // 无 knowledge/
    const bookRoot = join(dir, 'book')
    mkdirSync(bookRoot, { recursive: true })
    expect(seedBookKnowledge(bookRoot)).toEqual({ seeded: [], upgraded: [], kept: [] })
  })

  it('真实仓随包:listBundledSeedRels 含写稿选材四篇(非空)', () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const rels = listBundledSeedRels()
    expect(rels).toContain('追读力/章节钩子速查.md')
    expect(rels).toContain('爽点/反转设计速查.md')
    expect(rels).toContain('追读力/节奏与升级感速查.md')
    expect(rels).toContain('方法论/人物与对话技法速查.md')
    // 许可件不播种
    expect(rels.some((r) => r.startsWith('许可/'))).toBe(false)
  })
})
