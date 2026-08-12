/**
 * 章节元数据读写 —— 依据 #7 章节元数据 spec。
 *
 * 格式：写作/正文/<章号>-<标题>.md，含 front matter（章号/标题/钩子/情绪）+ 正文。
 * 字数不入 front matter（机检算的派生，#7 第 2 节）。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import { countWords } from './words.js'
import type { ChapterMeta, ParseError, HookType, HookLevel, Emotion, SceneType } from './types.js'

/** #7 第 3 节枚举值校验集 */
const HOOK_TYPES: HookType[] = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const HOOK_LEVELS: HookLevel[] = ['强', '中', '弱']
const EMOTIONS: Emotion[] = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES: SceneType[] = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

const KNOWN_FM_KEYS = new Set(['章号', '标题', '钩子类型', '钩子强弱', '情绪定位', '场景', '时间锚点', '字数目标', '目标情绪', '核心反转'])

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
  if (map.has('场景')) chapter.场景 = map.get('场景') as SceneType
  if (map.has('字数目标')) chapter.字数目标 = Number(map.get('字数目标'))
  if (map.has('目标情绪')) chapter.目标情绪 = String(map.get('目标情绪'))
  if (map.has('核心反转')) chapter.核心反转 = String(map.get('核心反转'))

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
  if (ch.场景) map.set('场景', ch.场景)
  if (ch.字数目标 !== undefined) map.set('字数目标', ch.字数目标)
  if (ch.目标情绪) map.set('目标情绪', ch.目标情绪)
  if (ch.核心反转) map.set('核心反转', ch.核心反转)
  if (ch._raw) {
    for (const [k, v] of Object.entries(ch._raw)) {
      if (!map.has(k)) map.set(k, v)
    }
  }
  return map
}

/** 写入章节 md（测试造章用；生产统一走 service.ts 写盘） */
export function writeChapter(filePath: string, ch: ChapterMeta, body: string): void {
  writeFile(filePath, stringifyFlat(chapterToMap(ch)), body)
}

/**
 * 枚举校验（#7 第 4 节，机检用）。
 * 错误文案带合法值清单——红项要回灌给 AI 自愈重写（self-heal 闭环），
 * 只说「越界」它改不对（实测连改 3 次仍填同一个非法值）。
 */
export function validateEnums(ch: ChapterMeta): string[] {
  const errs: string[] = []
  if (!HOOK_TYPES.includes(ch.钩子类型)) {
    errs.push(`钩子类型越界：${ch.钩子类型}（合法值：${HOOK_TYPES.join('/')}）`)
  }
  if (!HOOK_LEVELS.includes(ch.钩子强弱)) {
    errs.push(`钩子强弱越界：${ch.钩子强弱}（合法值：${HOOK_LEVELS.join('/')}）`)
  }
  if (!EMOTIONS.includes(ch.情绪定位)) {
    errs.push(`情绪定位越界：${ch.情绪定位}（合法值：${EMOTIONS.join('/')}）`)
  }
  if (ch.场景 && !SCENE_TYPES.includes(ch.场景)) {
    errs.push(`场景越界：${ch.场景}（合法值：${SCENE_TYPES.join('/')}）`)
  }
  return errs
}

/** 扫描目录读所有章节（容错，递归子目录——支持 写作/正文/<卷>/ 结构） */
export function readChapterDir(
  dirPath: string,
): { chapters: ChapterMeta[]; errors: ParseError[] } {
  const chapters: ChapterMeta[] = []
  const errors: ParseError[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('._')) continue
      const fp = join(dir, name)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(fp)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(fp) // 递归子目录（卷）
      } else if (name.endsWith('.md')) {
        const r = readChapter(fp)
        if (r.ok) chapters.push(r.chapter)
        else errors.push(r.error)
      }
    }
  }
  walk(dirPath)
  return { chapters, errors }
}

// re-export 抽离到 words.ts 的纯函数（保本模块 API 不变，T2.1）
export { countWords, parseChapterFileName } from './words.js'
