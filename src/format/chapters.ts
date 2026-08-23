/**
 * 章节元数据读写 —— 依据 #7 章节元数据 spec。
 *
 * 格式：写作/正文/<章号>-<标题>.md，含 front matter（章号/标题/钩子/情绪）+ 正文。
 * 字数不入 front matter（机检算的派生，#7 第 2 节）。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, parseFlat } from './frontmatter.js'
import { countWords, chapterFilePrefix } from './words.js'
import type { ChapterMeta, ParseError, HookType, HookLevel, Emotion, SceneType } from './types.js'

/** #7 第 3 节枚举值校验集 */
const HOOK_TYPES: HookType[] = ['危机钩', '悬念钩', '渴望钩', '情绪钩', '选择钩']
const HOOK_LEVELS: HookLevel[] = ['强', '中', '弱']
const EMOTIONS: Emotion[] = ['压抑', '铺垫', '小爽', '大爽', '转折']
const SCENE_TYPES: SceneType[] = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮']

const KNOWN_FM_KEYS = new Set(['章号', '标题', '钩子类型', '钩子强弱', '情绪定位', '场景', '时间锚点', '字数目标', '目标情绪', '核心反转'])

/** 读取章节 md → ChapterMeta（容错）。
 * @param includeBody W-P2-4：为 true 时把正文原文写入 _body（readChapterDir(includeBody=true) 一次读带出）；
 *                    默认缺省不驻留正文，既有调用方零成本。 */
export function readChapter(
  filePath: string,
  includeBody?: boolean,
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
    ...(includeBody ? { _body: r.body } : {}),
  }
  if (map.has('时间锚点')) chapter.时间锚点 = String(map.get('时间锚点'))
  if (map.has('场景')) chapter.场景 = map.get('场景') as SceneType
  if (map.has('字数目标')) chapter.字数目标 = Number(map.get('字数目标'))
  if (map.has('目标情绪')) chapter.目标情绪 = String(map.get('目标情绪'))
  if (map.has('核心反转')) chapter.核心反转 = String(map.get('核心反转'))

  return { ok: true, chapter }
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

/** 章号 → 按名定位文件时的全部合法前缀口径（单一真相源，CC-P2-21）。
 *  正文目录里三种命名并存：legacy 无补零（5-标题.md）、短篇/存量草稿 3 位补零、
 *  长篇写侧 4 位补零（M-4·第十一轮统一：service 改名 / 前端新建复制 / 草稿新建
 *  一律经 words.chapterFilePrefix 单源，原草稿新建 3 位已对齐 4 位）。按章号定位
 *  文件必须三口径全试——此前 RAG 召回精准读正文只试「无补零 + 4 位」，3 位命名的
 *  章静默返回 null。 */
export function chapterNamePrefixes(chapter: number): string[] {
  return [`${chapter}-`, chapterFilePrefix(chapter, 'piece'), chapterFilePrefix(chapter, 'chapter')]
}

/** 扫描目录读所有章节（容错，递归子目录——支持 写作/正文/<卷>/ 结构）。
 * @param includeBody W-P2-4：为 true 时带出 _body（正文原文），导出等「meta+body 都要」的调用方一次读；
 *                     默认缺省（undefined/false）不驻留正文，既有调用方零成本。 */
export function readChapterDir(
  dirPath: string,
  includeBody?: boolean,
): { chapters: ChapterMeta[]; errors: ParseError[] } {
  // includeBody=true（导出/短篇索引等低频「meta+body 都要」路径）：正文原文不驻留缓存，
  // 走现读原实现，避免缓存大 body 占内存。默认（false）走 stat 级缓存热路径。
  if (includeBody) return readChapterDirUncached(dirPath, includeBody)

  // CC-P1-3：stat 级章节元数据缓存——热路径（GET /books、GET /overview、机检、树红点聚合等）
  // 对数百章大书每轮全量 readFile+parse+countWords 会秒级阻塞事件循环。此处按 (mtimeMs,size)
  // 判定：文件未变（绝大多数）→ 跳过整读，只 stat；变化/新增/删除由每轮 walk 自愈。
  // 与 document/tree.ts probeCache 同口径（含 mtime+size 撞车理论窗口）。
  // 返回数组与章对象均为新引用（防调用方 sort/mutate 污染缓存）。
  const cache = chapterDirCache.get(dirPath) ?? new Map<string, ChapterDirEntry>()
  chapterDirCache.set(dirPath, cache)
  const chapters: ChapterMeta[] = []
  const errors: ParseError[] = []
  const seen = new Set<string>()
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
        const hit = cache.get(fp)
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
          chapters.push(cloneChapter(hit.chapter)) // Z-21：_raw 一并深拷贝——嵌套 mutate 不污染缓存
        } else {
          const r = readChapter(fp)
          if (r.ok) {
            cache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, chapter: r.chapter })
            chapters.push(cloneChapter(r.chapter))
          } else {
            errors.push(r.error)
            cache.delete(fp) // 读失败不缓存；稳定坏文件每轮重读（错误文件罕见，可接受）
          }
        }
        seen.add(fp)
      }
    }
  }
  walk(dirPath)
  // 清理已删除文件条目（结构变化自愈：删章/移章下一轮 walk 即失效）
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key)
  }
  return { chapters, errors }
}

/**
 * readChapterDir 的现读版本（includeBody=true 用）——原实现逻辑原样保留。
 * 正文原文（_body）不驻留缓存：导出/短篇索引低频，避免大 body 占内存。
 */
function readChapterDirUncached(
  dirPath: string,
  includeBody?: boolean,
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
        const r = readChapter(fp, includeBody)
        if (r.ok) chapters.push(r.chapter)
        else errors.push(r.error)
      }
    }
  }
  walk(dirPath)
  return { chapters, errors }
}

/** CC-P1-3：章节元数据缓存条目（stat 快照 + 章元数据，不含正文）。 */
/** Z-21（第五十八轮）：缓存章元数据克隆——浅拷贝之上再拷 _raw（嵌套对象与缓存共享
 *  会让「防调用方 mutate 污染缓存」的承诺对嵌套字段不成立） */
function cloneChapter(c: ChapterMeta): ChapterMeta {
  return { ...c, ...(c._raw !== undefined ? { _raw: { ...c._raw } } : {}) }
}

interface ChapterDirEntry {
  mtimeMs: number
  size: number
  chapter: ChapterMeta
}

/** CC-P1-3：进程级章节元数据缓存（dirPath → 文件路径 → 条目）。
 *  无上限（按书隔离，键含绝对路径；每章仅 fm 元数据 + 字数，数百章 KB 级）——与 tree probeCache 同策略。 */
const chapterDirCache = new Map<string, Map<string, ChapterDirEntry>>()

/** 清空章节元数据缓存（结构性 mutation 后防御性调用；正常由每轮 walk 自愈，测试用）。 */
export function clearChapterDirCache(): void {
  chapterDirCache.clear()
}

// re-export 抽离到 words.ts 的纯函数（保本模块 API 不变，T2.1）
export { countWords, parseChapterFileName } from './words.js'
