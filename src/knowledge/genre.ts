/**
 * 题材卡召回——按书题材命中卡（建书播种面与写稿注入面共用同一判据）。
 *
 * 题材卡是「长篇语境下的题材味校准」：一类一张，九段同构（题材核心 / 开场抓手 /
 * 冲突发动机 / 爽点与情绪释放 / 对话与声线 / 章尾钩子 / 场景颗粒 / 正文落点 /
 * 前中后期打法 / 节奏密度 / 本章取舍 / 禁止漂移），随包全量在位但**不全量下发**：
 * 32 张全播进书根是每本 +90KB 噪音，其中九成与本书题材无关。
 *
 * 判据 = 卡的 `aliases` 声明命中书题材（`book.yaml` 的 `book.genre`）：
 * - 判据取**书级 `book.yaml` 原文**（`readBookGenre`），不取 `global.json`
 *   `defaultGenre`——后者是建书表单的初值、不是「本书题材」这一事实；播种面拿不到
 *   用户数据目录，取全局默认会让播种面与注入面判据分叉（播种按 A、注入按 B）；
 * - 命中按三级打分（精确 > 题材含别名 > 别名含题材），同级按别名长度降序——
 *   长别名更具体（「都市脑洞」优于「脑洞」）；
 * - 取前 `GENRE_MAX_CARDS` 张（主卡 + 至多一张邻题材）。
 *
 * 两级 rank（书级 > 随包）与三面同源：召回判据取**随包卡**声明，正文经
 * `resolveCorpusFile` 解析（作者在书根 `知识层/题材/<同名>.md` 改的是正文，不改判据）。
 *
 * 装配（解析/截断/计量/拼段/登记/超帽处置）单源 = src/knowledge/inject.ts。
 * 容错：卡目录缺失/读失败 → 空候选（题材卡是增强面，绝不阻断写稿）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readBookConfig } from '../format/yaml.js'
import { readFile, parseFlat } from '../format/frontmatter.js'
import { bundledResource } from '../fs/resources.js'
import { log } from '../log/index.js'
import { assembleKnowledge, titleOf, type KnowledgeAssembly } from './inject.js'
import { GENRE_CATEGORY } from './catalog.js'
import { BUNDLED_KNOWLEDGE_SUBDIR } from './corpus.js'

/** 类目索引文件名（非语料副本，召回扫描跳过） */
const GENRE_INDEX_BASENAME = 'README.md'

/** 召回张数帽：主卡 + 至多一张邻题材卡 */
export const GENRE_MAX_CARDS = 2

/** 单张卡码点帽（卡写作规范上限 3500 的收紧值：召回取的是「校准题材味」一屏量） */
export const GENRE_FILE_CAP = 1600

/** 合计码点帽（两卡上限之和留余量） */
export const GENRE_TOTAL_CAP = 3000

/** 段头（整块前缀含其后换行） */
const GENRE_HEADING = '## 题材写作参考(按本书题材自动选取,冲突时以本书设定为准)\n'

/** 卡元信息（召回判据面：rel + 展示名 + 别名声明） */
export interface GenreCardMeta {
  /** 子集相对路径（`题材/<卡名>.md`） */
  rel: string
  /** 卡名（= 文件名去扩展名） */
  name: string
  /** 别名声明（命中判据；含卡名本身） */
  aliases: string[]
}

/** 别名声明解析：标量按单条、数组按序；去空项与重复项，声明序即优先序。 */
export function parseAliases(raw: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

/**
 * 随包题材卡元信息（随包扫描；卡目录缺失/读失败 → 空表）。
 *
 * 无缓存：一次调用 = 一次目录扫描 + 33 次小文件读（约 40KB），写稿组稿每章一次，
 * 量级远低于同轮已做的细纲/章纲/样章扫描；缓存要带指纹失效与测试资源目录切换，
 * 收益不抵复杂度。
 */
export function listBundledGenreCards(): GenreCardMeta[] {
  const dir = bundledResource(BUNDLED_KNOWLEDGE_SUBDIR, GENRE_CATEGORY)
  if (!existsSync(dir)) return []
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md') && !f.startsWith('.'))
  } catch (e) {
    log.warn(
      'knowledge-genre',
      `题材卡目录读取失败（本轮不召回）:${dir}(${e instanceof Error ? e.message : String(e)})`,
    )
    return []
  }
  const out: GenreCardMeta[] = []
  for (const f of files.sort()) {
    if (f === GENRE_INDEX_BASENAME) continue
    const fp = join(dir, f)
    let text: string
    try {
      text = readFileSync(fp, 'utf-8')
    } catch (e) {
      log.warn('knowledge-genre', `题材卡读取失败（跳过该卡）:${f}(${e instanceof Error ? e.message : String(e)})`)
      continue
    }
    const r = readFile(fp, text)
    // 无 fm 的裸 md：无从判命中，不入候选（判据面不猜）
    const aliases = r.ok ? parseAliases(parseFlat(r.fmRaw).get('aliases')) : []
    const name = basename(f, '.md')
    out.push({ rel: `${GENRE_CATEGORY}/${f}`, name, aliases: aliases.length > 0 ? aliases : [name] })
  }
  return out
}

/**
 * 命中打分：卡名命中恒定重于别名命中（名是全等的「一类一张」正名，别名是召回词）。
 *
 * 分值 1–6（卡名档 4–6 / 别名档 1–3），同名档内「对得更全」者高：
 * - 6 = 题材与卡名全等；5 = 题材含卡名（「悬疑灵异系统」含「悬疑灵异」）；
 *   4 = 卡名含题材（「悬疑灵异」含「悬疑」）；
 * - 3/2/1 为同三级作用在别名上的分值。
 *
 * 卡名与别名分档的理由：只按「全等 > 含 > 被含」排会让别名档的命中追平甚至反超
 * 卡名档（题材「悬疑」下，别名「女性悬疑」与卡名「悬疑灵异」同属「被含」，前者
 * 若按字典序排前，本书主卡就落到隔壁题材上）。
 */
function matchScore(genre: string, card: GenreCardMeta): { score: number; tokenLen: number } {
  let best = { score: 0, tokenLen: 0 }
  const consider = (score: number, token: string): void => {
    if (score > best.score || (score === best.score && score > 0 && token.length > best.tokenLen)) {
      best = { score, tokenLen: token.length }
    }
  }
  if (card.name === genre) consider(6, card.name)
  else if (genre.includes(card.name)) consider(5, card.name)
  else if (card.name.includes(genre)) consider(4, card.name)
  for (const a of card.aliases) {
    if (a === card.name) continue // 卡名已单独计档，别名表里的同项不再低档重复计
    if (a === genre) consider(3, a)
    else if (genre.includes(a)) consider(2, a)
    else if (a.includes(genre)) consider(1, a)
  }
  return best
}

/**
 * 按题材召回卡（确定性排序：命中分值降序 → 命中词长度降序 → 卡名序）。
 * `genre` 未设/空 → 空候选（不猜题材）。
 */
export function matchGenreCards(genre: string | undefined, cards: readonly GenreCardMeta[]): GenreCardMeta[] {
  const g = genre?.trim()
  if (!g) return []
  return cards
    .map((card) => ({ card, m: matchScore(g, card) }))
    .filter((x) => x.m.score > 0)
    .sort(
      (a, b) =>
        b.m.score - a.m.score ||
        b.m.tokenLen - a.m.tokenLen ||
        (a.card.name < b.card.name ? -1 : a.card.name > b.card.name ? 1 : 0),
    )
    .slice(0, GENRE_MAX_CARDS)
    .map((x) => x.card)
}

/** 本书题材（召回判据单源）：书级 `book.yaml` 的 `book.genre` 原文；未设/空白/读失败 → undefined。 */
export function readBookGenre(bookRoot: string | undefined): string | undefined {
  if (!bookRoot) return undefined
  try {
    const r = readBookConfig(join(bookRoot, 'book.yaml'))
    if (!r.ok) return undefined
    const g = r.config.book.genre
    return typeof g === 'string' && g.trim() !== '' ? g.trim() : undefined
  } catch {
    return undefined
  }
}

/** 本书召回的卡（读书题材 → 命中随包卡；供播种面与注入面复用同一函数） */
export function genreCardsForBook(bookRoot: string | undefined): GenreCardMeta[] {
  return matchGenreCards(readBookGenre(bookRoot), listBundledGenreCards())
}

/**
 * 组装写稿面题材参考段（空段 = 未命中任何卡，注入方按「空段不入 prompt 不登记」处置）。
 */
export function buildGenreInjection(args: { bookRoot?: string; genre?: string; enabled?: boolean }): KnowledgeAssembly {
  const genre = args.genre ?? readBookGenre(args.bookRoot)
  const cards = matchGenreCards(genre, listBundledGenreCards())
  const reasonOf = (rel: string): string => `题材命中:${titleOf(rel)}`
  if (cards.length === 0) {
    return { text: '', sources: [], records: [], dropped: [] }
  }
  return assembleKnowledge({
    bookRoot: args.bookRoot,
    rels: cards.map((c) => c.rel),
    heading: GENRE_HEADING,
    fileCap: GENRE_FILE_CAP,
    totalCap: GENRE_TOTAL_CAP,
    enabled: args.enabled,
    reasonOf,
  })
}
