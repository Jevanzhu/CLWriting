/**
 * 知识层统一语料解析——书级 > 随包 两级 rank(统一批)。
 *
 * 三面(写稿/三审/对话)同构读取:每篇按 relPath 先查书根 `知识层/<rel>`,
 * 命中用书的,否则回落随包 `resources/knowledge/<rel>`(rank 高覆盖低,同名去重)。
 * 书级副本 = 作者可编辑起点(建书播种,升级不覆盖已改);
 * 随包 = 恒在基线(书级缺失/为空时退化到它,存量书零影响)。
 */
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { resolveWithinRoot } from '../fs/safe-path.js'
import { bundledResource } from '../fs/resources.js'
import { bodyOf } from '../shared/frontmatter-core.js'
import { log } from '../log/index.js'

/** 书级知识层目录名(书根下) */
export const BOOK_KNOWLEDGE_DIR = '知识层'

/** 随包知识层目录(语言级相对 resources/) */
export const BUNDLED_KNOWLEDGE_SUBDIR = 'knowledge'

/** 解析结果:正文(已剥 fm)+ 登记名(相对书根或「知识层(内置)/」前缀) */
export interface ResolvedCorpus {
  /** 子集相对路径(如 `长篇/章节钩子速查.md`),两级同构 */
  rel: string
  /** 剥 fm 后的正文 */
  body: string
  /** 来源层:书级 or 随包 */
  layer: 'book' | 'bundled'
  /** 注入登记名——书级 = `知识层/<rel>`(书根相对);随包 = `知识层(内置)/<rel>` */
  source: string
}

/** 随包注入源登记前缀(bundled 不在书根下,与书内路径永不混同) */
export const BUNDLED_SOURCE_PREFIX = '知识层(内置)/'

/** 单篇读取上限防护:超此字节数不读(病态大文件不进 prompt;正常速查篇仅数 KB) */
const MAX_CORPUS_BYTES = 256 * 1024

/** 读文件为规范正文(剥 fm + trim);不存在/为空/超限/读失败 → null。 */
function readCorpusBody(abs: string): string | null {
  if (!existsSync(abs)) return null
  try {
    if (statSync(abs).size > MAX_CORPUS_BYTES) {
      log.warn('knowledge-corpus', `语料文件超限跳过(>${MAX_CORPUS_BYTES}B):${abs}`)
      return null
    }
    const body = bodyOf(readFileSync(abs, 'utf-8')).trim()
    return body === '' ? null : body
  } catch (e) {
    log.warn('knowledge-corpus', `语料读取失败跳过:${abs}(${e instanceof Error ? e.message : String(e)})`)
    return null
  }
}

/**
 * 按 relPath 两级解析单篇:书根 `知识层/<rel>` 优先,缺失/为空回落随包。
 * 书级 target 过 resolveWithinRoot 防越界(fail-closed:越界/符号链接逃逸 → 当缺失回落)。
 * 两级皆无 → null(调用方跳过留痕)。
 */
export function resolveCorpusFile(bookRoot: string | undefined, rel: string): ResolvedCorpus | null {
  if (bookRoot) {
    // 书级路径经安全解析(rel 来自常量或扫描结果,仍是「可篡改本地数据」面)
    const resolved = resolveWithinRoot(bookRoot, `${BOOK_KNOWLEDGE_DIR}/${rel}`)
    if (resolved) {
      const body = readCorpusBody(resolved.abs)
      if (body !== null) {
        return { rel, body, layer: 'book', source: `${BOOK_KNOWLEDGE_DIR}/${rel}` }
      }
    }
  }
  const body = readCorpusBody(bundledResource(BUNDLED_KNOWLEDGE_SUBDIR, ...rel.split('/')))
  if (body !== null) {
    return { rel, body, layer: 'bundled', source: `${BUNDLED_SOURCE_PREFIX}${rel}` }
  }
  return null
}

/** 目录扫描跳过的非语料文件名(说明/对账单/草稿/隐藏项) */
const SCAN_SKIP_BASENAMES = new Set(['README.md', '_manifest.json', 'versions.json'])

/**
 * 扫描 `<root>/<分类>/<篇>.md` 与书级/随包同构的语料清单(分类 = 一级目录名;
 * 跳过非语料项与隐藏项;rel 按字典序稳定排序)。
 *
 * 两级**共用同一实现**——此前书级/随包各持一份逐行同构的孪生(仅取根方式与日志
 * 措辞不同),任何判据变更都要改两处,漏一处即「两级口径分叉」(rank 语义的前提
 * 就是两级同构)。`label` 只进日志文案。
 *
 * 读失败 best-effort 跳过,绝不抛:调用方按「扫描失败 = 该面零注入」编码,
 * 抛出会破坏该契约(如整轮对话建上下文失败)。知识层是增强面,不阻断面。
 */
function scanKnowledgeEntries(root: string, label: string): Array<{ category: string; rel: string }> {
  if (!existsSync(root)) return []
  const out: Array<{ category: string; rel: string }> = []
  let categories: Dirent[]
  try {
    categories = readdirSync(root, { withFileTypes: true })
  } catch (e) {
    log.warn('knowledge-corpus', `${label}目录读取失败(跳过):${root}(${e instanceof Error ? e.message : String(e)})`)
    return []
  }
  for (const cat of categories) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue
    let files: Dirent[]
    try {
      files = readdirSync(join(root, cat.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.isFile() || f.name.startsWith('.') || SCAN_SKIP_BASENAMES.has(f.name)) continue
      if (!f.name.toLowerCase().endsWith('.md')) continue
      out.push({ category: cat.name, rel: `${cat.name}/${f.name}` })
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** 书根知识层(`<bookRoot>/知识层/`)的语料清单 */
export function listBookKnowledgeEntries(bookRoot: string): Array<{ category: string; rel: string }> {
  return scanKnowledgeEntries(join(bookRoot, BOOK_KNOWLEDGE_DIR), '知识层')
}

/** 随包知识层(`resources/knowledge/`)的语料清单——与书级同构,判据单源 */
export function listBundledKnowledgeEntries(): Array<{ category: string; rel: string }> {
  return scanKnowledgeEntries(bundledResource(BUNDLED_KNOWLEDGE_SUBDIR), '随包知识层')
}
