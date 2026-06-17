/**
 * 章节元数据读写 —— 依据 #7 章节元数据 spec。
 *
 * 格式：定稿/正文/<章号>-<标题>.md，含 front matter（章号/标题/钩子/情绪）+ 正文。
 * 字数不入 front matter（机检算的派生，#7 第 2 节）。
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import type { ChapterMeta, ParseError, HookType, HookLevel, Emotion } from './types.js'

/** #7 第 3 节枚举值校验集 */
const HOOK_TYPES: HookType[] = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const HOOK_LEVELS: HookLevel[] = ['强', '中', '弱']
const EMOTIONS: Emotion[] = ['压抑', '铺垫', '小爽', '大爽', '转折']

const KNOWN_FM_KEYS = new Set(['章号', '标题', '钩子类型', '钩子强弱', '情绪定位', '时间锚点'])

/** 计算正文字数（中文按字符计，#7 第 2 节） */
export function countWords(body: string): number {
  // 去掉 markdown 标记后按字符计（粗估，零 token）
  return body.replace(/[#>*_`~\-\[\]()!\s]/g, '').length
}

/** 读取章节 md → ChapterMeta（容错） */
export function readChapter(
  filePath: string,
): { ok: true; chapter: ChapterMeta } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)
  const 章号 = map.get('章号')

  if (typeof 章号 !== 'number') {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：章号（int）' } }
  }

  // 收集未知字段
  const _raw: Record<string, string> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) _raw[k] = String(v)
  }

  const chapter: ChapterMeta = {
    章号,
    标题: String(map.get('标题') ?? ''),
    钩子类型: (map.get('钩子类型') as HookType) ?? '悬念钩',
    钩子强弱: (map.get('钩子强弱') as HookLevel) ?? '中',
    情绪定位: (map.get('情绪定位') as Emotion) ?? '铺垫',
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    _path: filePath,
    _wordCount: countWords(r.body),
  }
  if (map.has('时间锚点')) chapter.时间锚点 = String(map.get('时间锚点'))

  return { ok: true, chapter }
}

/** ChapterMeta → front matter Map */
function chapterToMap(ch: ChapterMeta): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('章号', ch.章号)
  map.set('标题', ch.标题)
  map.set('钩子类型', ch.钩子类型)
  map.set('钩子强弱', ch.钩子强弱)
  map.set('情绪定位', ch.情绪定位)
  if (ch.时间锚点) map.set('时间锚点', ch.时间锚点)
  if (ch._raw) {
    for (const [k, v] of Object.entries(ch._raw)) {
      if (!map.has(k)) map.set(k, v)
    }
  }
  return map
}

/** 写入章节 md */
export function writeChapter(filePath: string, ch: ChapterMeta, body: string): void {
  writeFile(filePath, stringifyFlat(chapterToMap(ch)), body)
}

/** 枚举校验（#7 第 4 节，机检用） */
export function validateEnums(ch: ChapterMeta): string[] {
  const errs: string[] = []
  if (!HOOK_TYPES.includes(ch.钩子类型)) errs.push(`钩子类型越界：${ch.钩子类型}`)
  if (!HOOK_LEVELS.includes(ch.钩子强弱)) errs.push(`钩子强弱越界：${ch.钩子强弱}`)
  if (!EMOTIONS.includes(ch.情绪定位)) errs.push(`情绪定位越界：${ch.情绪定位}`)
  return errs
}

/** 从文件名提取章号（定稿/正文/152-北境的雪.md → 152） */
export function parseChapterFileName(fileName: string): { 章号: number; 标题: string } | null {
  const base = basename(fileName, '.md')
  const m = base.match(/^(\d+)-(.+)$/)
  if (!m) return null
  return { 章号: Number(m[1]!), 标题: m[2]! }
}

/** 扫描定稿/正文/ 目录，读所有章节（容错） */
export function readChapterDir(
  dirPath: string,
): { chapters: ChapterMeta[]; errors: ParseError[] } {
  const chapters: ChapterMeta[] = []
  const errors: ParseError[] = []
  let files: string[]
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return { chapters, errors }
  }
  for (const f of files) {
    const fp = join(dirPath, f)
    if (!statSync(fp).isFile()) continue
    const r = readChapter(fp)
    if (r.ok) chapters.push(r.chapter)
    else errors.push(r.error)
  }
  return { chapters, errors }
}
