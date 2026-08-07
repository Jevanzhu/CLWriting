/**
 * 短篇正文元数据读写 —— 依据 M8 #27。
 *
 * 短篇落点：写作/正文/<篇号>-<标题>.md，含 front matter（篇号/标题/目标情绪/核心反转）+ 正文。
 * 清单分离到 大纲/清单/<篇号>-<标题>.md（与正文同文件名、不同目录，互不混放）。
 * 与长篇 chapters.ts 分轨：短篇目标函数是单篇情绪爆破，字段集不重合（无钩子类型/情绪定位）。
 * 复用 frontmatter.ts 的 readFile/parseFlat/stringifyFlat 容错骨架，零第三方依赖。
 */

import { readdirSync, existsSync, renameSync, rmdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import { countWords } from './chapters.js'
import type { PieceMeta, HookType, HookLevel, Emotion, SceneType, ParseError } from './types.js'

/** 短篇正文 front matter 已知字段（区分已知 vs 未知容错保留） */
const KNOWN_FM_KEYS = new Set([
  '篇号', '标题', '目标情绪', '核心反转',
  '钩子类型', '钩子强弱', '情绪定位', '场景', '字数目标',
])

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
  // 连续故事可选字段（对齐 ChapterMeta）
  if (map.has('钩子类型')) piece.钩子类型 = String(map.get('钩子类型')) as HookType
  if (map.has('钩子强弱')) piece.钩子强弱 = String(map.get('钩子强弱')) as HookLevel
  if (map.has('情绪定位')) piece.情绪定位 = String(map.get('情绪定位')) as Emotion
  if (map.has('场景')) piece.场景 = String(map.get('场景')) as SceneType
  const wc = map.get('字数目标')
  if (typeof wc === 'number') piece.字数目标 = wc

  return { ok: true, piece }
}

/** PieceMeta → front matter Map */
function pieceToMap(p: PieceMeta): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('篇号', p.篇号)
  map.set('标题', p.标题)
  if (p.目标情绪) map.set('目标情绪', p.目标情绪)
  if (p.核心反转) map.set('核心反转', p.核心反转)
  // 连续故事可选字段（对齐 ChapterMeta）
  if (p.钩子类型) map.set('钩子类型', p.钩子类型)
  if (p.钩子强弱) map.set('钩子强弱', p.钩子强弱)
  if (p.情绪定位) map.set('情绪定位', p.情绪定位)
  if (p.场景) map.set('场景', p.场景)
  if (p.字数目标) map.set('字数目标', p.字数目标)
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

/** 从文件名提取篇号 + 标题（篇/001-标题.md → 篇号 1，标题「标题」） */
export function parsePieceFileName(fileName: string): { 篇号: number; 标题: string } | null {
  // 归一化：去 .md 后缀 + 按 / 切段，取末段（文件名 = 篇号-标题）
  const norm = fileName.replace(/\.md$/, '').replace(/\\/g, '/')
  const segs = norm.split('/').filter(Boolean)
  const fileSeg = segs[segs.length - 1]!
  const m = fileSeg.match(/^(\d+)-(.+)$/)
  if (!m) return null
  return { 篇号: Number(m[1]!), 标题: m[2]! }
}

/**
 * 扫描 写作/正文/ 目录，读所有已定稿篇正文（容错）。
 * 每个 .md 文件 写作/正文/<篇号>-<标题>.md 读正文。
 */
export function readPieceDir(
  dirPath: string,
): { pieces: PieceMeta[]; errors: ParseError[] } {
  const pieces: PieceMeta[] = []
  const errors: ParseError[] = []
  let files: string[]
  try {
    files = readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isFile() && /^\d+-.*\.md$/.test(e.name) && !e.name.startsWith('._'))
      .map((e) => e.name)
  } catch {
    return { pieces, errors }
  }
  for (const f of files) {
    const r = readPiece(join(dirPath, f))
    if (r.ok) pieces.push(r.piece)
    else errors.push(r.error)
  }
  return { pieces, errors }
}

/**
 * 扫 写作/正文/ 目录下格式合法的篇文件数（<篇号>-<标题>.md）。
 * 与 state.ts countPieces 同口径：只计 `^\d+-*.md` 文件名，不计散文件/隐藏项。
 * state.ts 复用本函数作单源（避免两份计数逻辑漂移）。
 */
export function countPieces(篇Root: string, excludeNames?: Set<string>): number {
  try {
    return readdirSync(篇Root, { withFileTypes: true })
      .filter((e) => e.isFile() && /^\d+-.*\.md$/.test(e.name))
      .filter((e) => !excludeNames?.has(e.name))
      .length
  } catch {
    return 0
  }
}

/**
 * 迁移旧短篇目录结构（篇/N-T/正文.md + 篇/N-T/清单.md → 篇/N-T.md + 清单/N-T.md）。
 * 幂等：无旧结构（无 篇/N-T/ 子目录）则 no-op。server 启动时对每本书库调用一次。
 */
export function migratePieceLayout(bookRoot: string): { migrated: number; errors: string[] } {
  const piecesDir = join(bookRoot, '篇')
  if (!existsSync(piecesDir)) return { migrated: 0, errors: [] }
  let oldDirs: string[]
  try {
    oldDirs = readdirSync(piecesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
      .map((e) => e.name)
  } catch {
    return { migrated: 0, errors: [] }
  }
  if (oldDirs.length === 0) return { migrated: 0, errors: [] }

  const 清单Dir = join(bookRoot, '清单')
  let migrated = 0
  const errors: string[] = []
  for (const dirName of oldDirs) {
    const oldDir = join(piecesDir, dirName)
    const oldBody = join(oldDir, '正文.md')
    if (!existsSync(oldBody)) continue // 无正文.md 的目录跳过（非旧结构）
    // 搬正文：篇/N-T/正文.md → 篇/N-T.md（目标已存在则跳过，防 POSIX rename 原子覆盖丢文件）
    const newBody = join(piecesDir, `${dirName}.md`)
    if (existsSync(newBody)) {
      errors.push(`${dirName}: 目标 ${dirName}.md 已存在，跳过迁移`)
      continue
    }
    try {
      renameSync(oldBody, newBody)
      migrated++
    } catch (e) {
      errors.push(`${dirName}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    // 搬清单：篇/N-T/清单.md → 清单/N-T.md
    const oldList = join(oldDir, '清单.md')
    if (existsSync(oldList)) {
      mkdirSync(清单Dir, { recursive: true })
      const newList = join(清单Dir, `${dirName}.md`)
      if (existsSync(newList)) {
        errors.push(`${dirName}: 清单目标已存在，跳过`)
      } else {
        try {
          renameSync(oldList, newList)
        } catch {
          // 清单搬运失败不阻断（附属数据，非致命）
        }
      }
    }
    // 删空目录（残留其他文件则保留）
    try {
      rmdirSync(oldDir)
    } catch {
      // 目录非空，保留
    }
  }
  return { migrated, errors }
}
