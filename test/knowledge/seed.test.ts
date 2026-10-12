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
    expect(seedBookKnowledge(bookRoot)).toEqual({ seeded: [], upgraded: [], kept: [], retired: [] })
  })

  it('真实仓随包:播种面含通用档 9 篇(建书播种天然覆盖新篇,无需登记表)', () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const rels = listBundledSeedRels()
    // 写入稿选材四篇(旧 rel,退役数据随 D2 落,本批不动)
    expect(rels).toContain('追读力/章节钩子速查.md')
    expect(rels).toContain('爽点/反转设计速查.md')
    expect(rels).toContain('追读力/节奏与升级感速查.md')
    expect(rels).toContain('方法论/人物与对话技法速查.md')
    // 语料重建批:通用 9 篇在播种面(播种 = 随包扫描,新篇不需另登记)
    const general = rels.filter((r) => r.startsWith('通用/'))
    expect(general.length).toBe(9)
    expect(general).toContain('通用/情节推演速查.md')
    // 许可件不播种
    expect(rels.some((r) => r.startsWith('许可/'))).toBe(false)
  })
})

// ── 旧件退役（退役段驱动：只删登记在退役段且书级未改动的件）────────────────────
// 退役数据（旧 6 rel 入退役段）随 D2 收口落；本组造退役段直测机制。
describe('旧件退役（未改动删除 / 作者改过保留 / 未登记不误删 / 退役段空不删）', () => {
  /** 造随包 + 退役段；返回退役段所用哈希 */
  async function stubRetired(args: {
    live?: Record<string, string>
    retired: Record<string, string> // rel → 正文（哈希由本函数实算）
  }): Promise<Record<string, string[]>> {
    const { hashBytes } = await import('../../src/fs/hash.js')
    const live = args.live ?? {}
    for (const [rel, body] of Object.entries(live)) {
      const abs = join(dir, 'knowledge', ...rel.split('/'))
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, body)
    }
    const table: Record<string, string[]> = {}
    const retiredSeg: Record<string, string[]> = {}
    for (const [rel, body] of Object.entries(args.retired)) {
      const h = hashBytes(Buffer.from(body))
      table[rel] = [h]
      retiredSeg[rel] = [h]
    }
    for (const [rel, body] of Object.entries(live)) table[rel] = [hashBytes(Buffer.from(body))]
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(
      join(dir, 'knowledge', 'versions.json'),
      JSON.stringify({ ...table, __retired__: retiredSeg }, null, 2),
    )
    process.env['CLWRITING_RESOURCES_DIR'] = dir
    return retiredSeg
  }

  it('未改动的旧件（书级哈希命中退役段）→ 删除并记 retired', async () => {
    const OLD = '旧钩子篇正文。'
    await stubRetired({ live: { '通用/情节推演速查.md': '新篇。' }, retired: { '追读力/章节钩子速查.md': OLD } })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, OLD) // 书级 = 未改动的原样拷贝
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual(['追读力/章节钩子速查.md'])
    expect(existsSync(dst)).toBe(false)
    // 新篇照常播种
    expect(r.seeded).toContain('通用/情节推演速查.md')
  })

  it('作者改过的旧件 → 保留并记 kept（永不删作者自有内容）', async () => {
    await stubRetired({ retired: { '追读力/章节钩子速查.md': '旧版原样。' } })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '作者大改过的口径。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(r.kept).toContain('追读力/章节钩子速查.md')
    expect(readFileSync(dst, 'utf-8')).toBe('作者大改过的口径。')
  })

  it('书级自发新件（不在退役段）不误删', async () => {
    await stubRetired({ retired: { '追读力/章节钩子速查.md': '旧版原样。' } })
    const bookRoot = join(dir, 'book')
    const mine = join(bookRoot, '知识层', '我的类目', '自建篇.md')
    mkdirSync(join(mine, '..'), { recursive: true })
    writeFileSync(mine, '作者自建。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(existsSync(mine)).toBe(true)
  })

  it('退役段为空 → 不删任何件（机制在位、数据随批落）', () => {
    // versions 表只有主段（无 __retired__ 键）
    stubBundled({ '通用/情节推演速查.md': '新篇。' }, { '通用/情节推演速查.md': [] })
    const bookRoot = join(dir, 'book')
    const old = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(old, '..'), { recursive: true })
    writeFileSync(old, '旧件原样（退役段为空 → 留着）。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(existsSync(old)).toBe(true)
  })

  it('建书播种（seedOnly）不退役——新书根无历史件，退役归升级链', async () => {
    await stubRetired({ retired: { '追读力/章节钩子速查.md': '旧版原样。' } })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '旧版原样。')
    const r = seedBookKnowledge(bookRoot, { seedOnly: true })
    expect(r.retired).toEqual([])
    expect(existsSync(dst)).toBe(true)
  })

  it('退役段含仍在随包的 rel → 不删（同名换位交播种/升级步处置）', async () => {
    await stubRetired({
      live: { '追读力/章节钩子速查.md': '随包现役同 rel。' },
      retired: { '追读力/章节钩子速查.md': '旧版原样。' },
    })
    const bookRoot = join(dir, 'book')
    const dst = join(bookRoot, '知识层', '追读力', '章节钩子速查.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '旧版原样。')
    const r = seedBookKnowledge(bookRoot)
    expect(r.retired).toEqual([])
    expect(existsSync(dst)).toBe(true)
  })
})
