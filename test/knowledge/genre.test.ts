/**
 * 题材卡召回（src/knowledge/genre.ts）单测。
 *
 * 锚定对外可观察行为：
 * 1) 别名命中打分（全等 > 题材含别名 > 别名含题材）与取张数帽；
 * 2) 未设题材不召回（不猜）；
 * 3) 段文本按真实随包卡组装（书级同名覆盖随包）；命中为零 → 空段；
 * 4) 开关关停 → 段与登记一并空，逐卡记 switch-off。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  buildGenreInjection,
  genreCardsForBook,
  listBundledGenreCards,
  matchGenreCards,
  parseAliases,
  readBookGenre,
  type GenreCardMeta,
} from '../../src/knowledge/genre.js'

let dir: string
let prevResourcesDir: string | undefined

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-genre-'))
  prevResourcesDir = process.env['CLWRITING_RESOURCES_DIR']
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (prevResourcesDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = prevResourcesDir
})

/** 造受限随包资源根：knowledge/题材/<卡>.md（带 aliases fm）。 */
function stubCards(cards: Record<string, string[]>): void {
  for (const [name, aliases] of Object.entries(cards)) {
    const abs = join(dir, 'knowledge', '题材', `${name}.md`)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, `---\naliases: [${aliases.join(', ')}]\n---\n\n# ${name}卡\n\n卡正文。\n`)
  }
  process.env['CLWRITING_RESOURCES_DIR'] = dir
}

/** 造书根（book.yaml 带 genre）。 */
function makeBook(name: string, genre?: string): string {
  const bookRoot = join(dir, name)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), `book:\n  title: ${name}\n${genre ? `  genre: ${genre}\n` : ''}`)
  return bookRoot
}

const card = (name: string, aliases: string[]): GenreCardMeta => ({ rel: `题材/${name}.md`, name, aliases })

describe('别名解析与命中排序', () => {
  it('parseAliases：标量按单条、数组按序；去空项与重复项；非字符串项跳过', () => {
    expect(parseAliases(['a', ' b ', 'a', '', 'c'])).toEqual(['a', 'b', 'c'])
    expect(parseAliases('独条')).toEqual(['独条'])
    expect(parseAliases(undefined)).toEqual([])
    expect(parseAliases([1, 'x', null])).toEqual(['x'])
  })

  it('卡名全等（6 分）> 卡名被题材含（5）> 卡名含题材（4）> 别名三级（3/2/1）', () => {
    const cards = [card('都市脑洞', ['都市脑洞', '脑洞']), card('都市日常', ['日常文'])]
    // 与卡名全等 → 6 分，甩开「都市日常」的卡名含题材（4 分）
    expect(matchGenreCards('都市脑洞', cards).map((c) => c.name)).toEqual(['都市脑洞'])
    // 「都市脑洞系统」：都市脑洞 5 分（题材含卡名）；都市日常 0 分（名与别名都不含）
    expect(matchGenreCards('都市脑洞系统', cards).map((c) => c.name)).toEqual(['都市脑洞'])
  })

  it('卡名档重于别名档：只有别名命中的卡排在只有卡名命中的卡之后', () => {
    // 题材「悬疑」：甲靠【卡名】含悬疑（4 分）；乙的卡名与题材无关，靠【别名】「女性悬疑」被含（1 分）
    const cards = [card('乙卡', ['乙卡', '女性悬疑']), card('悬疑灵异', ['悬疑灵异', '灵异'])]
    expect(matchGenreCards('悬疑', cards).map((c) => c.name)).toEqual(['悬疑灵异', '乙卡'])
    // 别名档内仍分级：题材含别名（2 分）> 别名含题材（1 分）——后者排后
    const aliasOnly = [card('A', ['末世废土风云']), card('B', ['末世'])]
    expect(matchGenreCards('末世废土', aliasOnly).map((c) => c.name)).toEqual(['B', 'A'])
  })

  it('同分同名长 → 按卡名序（确定性；两侧都是「名含题材」时无优劣判据，取稳定序）', () => {
    const cards = [card('悬疑灵异', ['悬疑灵异']), card('女频悬疑', ['女频悬疑'])]
    expect(matchGenreCards('悬疑', cards).map((c) => c.name)).toEqual(['女频悬疑', '悬疑灵异'])
  })

  it('取张数帽：至多 2 张（命中多张时按打分序取前 2）', () => {
    const cards = [card('甲', ['都市']), card('乙', ['都市脑洞']), card('丙', ['都市脑洞系统'])]
    // 题材「都市脑洞系统」：丙 5 分（题材含卡名）> 乙 4 分（名含题材）> 甲 1 分（别名含题材）
    const got = matchGenreCards('都市脑洞系统', cards)
    expect(got.length).toBe(2)
    expect(got.map((c) => c.name)).toEqual(['丙', '乙'])
  })

  it('未设/空白题材 → 不召回（不猜）', () => {
    const cards = [card('都市脑洞', ['都市脑洞'])]
    expect(matchGenreCards(undefined, cards)).toEqual([])
    expect(matchGenreCards('', cards)).toEqual([])
    expect(matchGenreCards('   ', cards)).toEqual([])
  })
})

describe('书题材判据与随包卡清单', () => {
  it('readBookGenre：书级 book.yaml 的 genre 原文；未设/无书 → undefined', () => {
    expect(readBookGenre(makeBook('设了', '都市脑洞'))).toBe('都市脑洞')
    expect(readBookGenre(makeBook('没设'))).toBeUndefined()
    expect(readBookGenre(undefined)).toBeUndefined()
  })

  it('listBundledGenreCards：读 aliases；无 fm 的裸卡回落卡名（不猜判据）', () => {
    stubCards({ 都市脑洞: ['都市脑洞', '脑洞'] })
    mkdirSync(join(dir, 'knowledge', '题材'), { recursive: true })
    writeFileSync(join(dir, 'knowledge', '题材', '裸卡.md'), '# 无 fm\n\n正文。\n')
    const cards = listBundledGenreCards()
    expect(cards.find((c) => c.name === '都市脑洞')?.aliases).toEqual(['都市脑洞', '脑洞'])
    expect(cards.find((c) => c.name === '裸卡')?.aliases).toEqual(['裸卡'])
  })

  it('genreCardsForBook：书题材命中随包卡（播种面与注入面同一函数）', () => {
    stubCards({ 都市脑洞: ['都市脑洞'], 悬疑灵异: ['悬疑灵异'] })
    const bookRoot = makeBook('命中书', '都市脑洞')
    expect(genreCardsForBook(bookRoot).map((c) => c.rel)).toEqual(['题材/都市脑洞.md'])
  })
})

describe('题材参考段组装', () => {
  it('未设题材 → 空段（不入 prompt 不登记）', () => {
    stubCards({ 都市脑洞: ['都市脑洞'] })
    const a = buildGenreInjection({ bookRoot: makeBook('无题材书') })
    expect(a.text).toBe('')
    expect(a.sources).toEqual([])
    expect(a.records).toEqual([])
    expect(a.dropped).toEqual([])
  })

  it('未命中任何卡 → 空段（题材不在 32 卡覆盖面内不硬套）', () => {
    stubCards({ 都市脑洞: ['都市脑洞'] })
    expect(buildGenreInjection({ bookRoot: makeBook('冷门书', '克苏鲁钓鱼') }).text).toBe('')
  })

  it('命中 → 段头 + 卡正文；登记名带随包前缀；reason 记题材命中', () => {
    stubCards({ 都市脑洞: ['都市脑洞'] })
    const a = buildGenreInjection({ bookRoot: makeBook('命中书', '都市脑洞') })
    expect(a.text.startsWith('## 题材写作参考(按本书题材自动选取,冲突时以本书设定为准)\n')).toBe(true)
    expect(a.text).toContain('### 都市脑洞')
    expect(a.sources).toEqual(['知识层(内置)/题材/都市脑洞.md'])
    expect(a.records[0]!.reason).toBe('题材命中:都市脑洞')
    expect(a.records[0]!.layer).toBe('bundled')
  })

  it('书级同名覆盖随包：正文取书级件，判据仍按随包卡别名', () => {
    stubCards({ 都市脑洞: ['都市脑洞'] })
    const bookRoot = makeBook('覆盖书', '都市脑洞')
    const dst = join(bookRoot, '知识层', '题材', '都市脑洞.md')
    mkdirSync(join(dst, '..'), { recursive: true })
    writeFileSync(dst, '---\nlicense: MIT\n---\n\n# 作者改过的卡\n\n作者口径。\n')
    const a = buildGenreInjection({ bookRoot })
    expect(a.text).toContain('作者口径。')
    expect(a.sources).toEqual(['知识层/题材/都市脑洞.md'])
    expect(a.records[0]!.layer).toBe('book')
  })

  it('开关关停 → 段与登记一并空，逐卡记 switch-off', () => {
    stubCards({ 都市脑洞: ['都市脑洞'] })
    const a = buildGenreInjection({ bookRoot: makeBook('关停书', '都市脑洞'), enabled: false })
    expect(a.text).toBe('')
    expect(a.records).toEqual([])
    expect(a.dropped).toEqual([{ rel: '题材/都市脑洞.md', reason: 'switch-off' }])
  })
})

describe('真实仓随包卡（召回判据与目录实态对齐）', () => {
  it('32 张卡全在位、别名非空、与 catalog 声明面逐张对齐', async () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const cards = listBundledGenreCards()
    expect(cards.length).toBe(32)
    const { GENRE_CATALOG } = await import('../../src/knowledge/catalog.js')
    expect(cards.map((c) => c.rel).sort()).toEqual(GENRE_CATALOG.map((e) => e.rel).sort())
    for (const c of cards) expect(c.aliases.length, c.rel).toBeGreaterThan(0)
  })

  it('真书题材命中真卡（端到端：段文本含该卡正文）', () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const bookRoot = makeBook('真命题书', '末世')
    const a = buildGenreInjection({ bookRoot })
    expect(a.records.map((r) => r.rel)).toContain('题材/科幻末世.md')
    expect(a.text).toContain('### 科幻末世')
    expect(a.text).toContain('末世')
  })

  it('段体量在帽内：单卡不截断（卡正文 ≤ 单卡帽）', () => {
    delete process.env['CLWRITING_RESOURCES_DIR']
    const bookRoot = makeBook('帽检书', '仙侠')
    const a = buildGenreInjection({ bookRoot })
    expect(a.records.length).toBeGreaterThan(0)
    for (const r of a.records) expect(r.truncated, r.rel).toBe(false)
  })
})
