/**
 * 短篇正文元数据读写 —— 依据 M8 #27。
 *
 * 短篇落点：篇/<篇号>-<标题>/正文.md，含 front matter（篇号/标题/目标情绪/核心反转）+ 正文。
 * 与长篇 chapters.ts 分轨：短篇目标函数是单篇情绪爆破，字段集不重合（无钩子类型/情绪定位）。
 * 复用 frontmatter.ts 的 readFile/parseFlat/stringifyFlat 容错骨架，零第三方依赖。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import { countWords } from './chapters.js'
import type { PieceMeta, ParseError } from './types.js'

/** 短篇正文 front matter 已知字段（区分已知 vs 未知容错保留） */
const KNOWN_FM_KEYS = new Set(['篇号', '标题', '目标情绪', '核心反转'])

/** 读取短篇正文 md → PieceMeta（容错） */
export function readPiece(
  filePath: string,
): { ok: true; piece: PieceMeta } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)
  const 篇号 = map.get('篇号')

  if (typeof 篇号 !== 'number') {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：篇号（int）' } }
  }

  // 收集未知字段（容错保留，对齐 #3 第 8 节）
  const _raw: Record<string, string> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) _raw[k] = String(v)
  }

  const piece: PieceMeta = {
    篇号,
    标题: String(map.get('标题') ?? ''),
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    _path: filePath,
    _wordCount: countWords(r.body),
  }
  if (map.has('目标情绪')) piece.目标情绪 = String(map.get('目标情绪'))
  if (map.has('核心反转')) piece.核心反转 = String(map.get('核心反转'))

  return { ok: true, piece }
}

/** PieceMeta → front matter Map */
function pieceToMap(p: PieceMeta): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('篇号', p.篇号)
  map.set('标题', p.标题)
  if (p.目标情绪) map.set('目标情绪', p.目标情绪)
  if (p.核心反转) map.set('核心反转', p.核心反转)
  if (p._raw) {
    for (const [k, v] of Object.entries(p._raw)) {
      if (!map.has(k)) map.set(k, v)
    }
  }
  return map
}

/** 写入短篇正文 md */
export function writePiece(filePath: string, p: PieceMeta, body: string): void {
  writeFile(filePath, stringifyFlat(pieceToMap(p)), body)
}

/** 从文件名/目录名提取篇号 + 标题（篇/001-标题/正文.md 或 001-标题 → 篇号 1，标题「标题」） */
export function parsePieceFileName(fileName: string): { 篇号: number; 标题: string } | null {
  // 归一化：去 .md 后缀 + 按 / 切段，取倒数第二段（篇目录名）或末段
  const norm = fileName.replace(/\.md$/, '').replace(/\\/g, '/')
  const segs = norm.split('/').filter(Boolean)
  const dirSeg = segs.length > 1 ? segs[segs.length - 2]! : segs[0]!
  const m = dirSeg.match(/^(\d+)-(.+)$/)
  if (!m) return null
  return { 篇号: Number(m[1]!), 标题: m[2]! }
}

/**
 * 扫描 篇/ 目录，读所有已定稿篇正文（容错）。
 * 每个子目录 篇/<篇号>-<标题>/ 读 正文.md。
 */
export function readPieceDir(
  dirPath: string,
): { pieces: PieceMeta[]; errors: ParseError[] } {
  const pieces: PieceMeta[] = []
  const errors: ParseError[] = []
  let dirs: string[]
  try {
    dirs = readdirSync(dirPath).filter((d) => !d.startsWith('.') && !d.startsWith('._'))
  } catch {
    return { pieces, errors }
  }
  for (const d of dirs) {
    const dp = join(dirPath, d)
    if (!statSync(dp).isDirectory()) continue
    const fp = join(dp, '正文.md')
    const r = readPiece(fp)
    if (r.ok) pieces.push(r.piece)
    else errors.push(r.error)
  }
  return { pieces, errors }
}

/**
 * 扫 篇/ 目录下格式合法的篇子目录数（<篇号>-<标题>/）。
 * 与 state.ts countPieces 同口径：只计 `^\d+-` 目录名，不计散文件/隐藏项。
 * state.ts 复用本函数作单源（避免两份计数逻辑漂移）。
 */
export function countPieces(篇Root: string): number {
  try {
    return readdirSync(篇Root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
      .length
  } catch {
    return 0
  }
}
