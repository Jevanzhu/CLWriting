/**
 * 章节元数据读写 —— 依据 #7 章节元数据 spec。
 *
 * 格式：写作/正文/<章号>-<标题>.md，含 front matter（章号/标题/钩子/情绪）+ 正文。
 * 字数不入 front matter（机检算的派生，#7 第 2 节）。
 */

import { statSync } from 'node:fs'
import { sep } from 'node:path'
import { walkMdEach } from '../fs/walk-md.js'
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
 *                    默认缺省不驻留正文，既有调用方零成本。
 * @param content R63-7（十一轮）：预读文本（调用方单次读取的快照）——传入时不再读文件，
 *                机检/三审与 hash 从同一快照派生（三审端点三次独立读会来自三个时刻）。 */
export function readChapter(
  filePath: string,
  includeBody?: boolean,
  content?: string,
): { ok: true; chapter: ChapterMeta } | { ok: false; error: ParseError } {
  const r = readFile(filePath, content)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)
  const 章号Raw = map.get('章号')
  // R62-13：章号门槛收敛到 number——front matter 由 AI 产出/作者手改，`章号: 5`（int）
  // 与 `章号: "5"`（parseValue 对带引号值 unquote 后回落字符串）都该认；缺字段与
  // 非数字格式（`章号: 五`、`章号: 5.0`）维持错误，但文案区分「缺少」与「格式不符」，
  // 便于 AI 自愈/作者改对（此前带引号整章对本系统隐形——导出 warnings、近况组装、
  // 前章结尾段、场景水源、draft-pipeline 全部消费方读不到）。
  let 章号: number
  if (章号Raw === undefined || 章号Raw === null || 章号Raw === '') {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：章号' } }
  } else if (typeof 章号Raw === 'number') {
    章号 = 章号Raw
  } else if (typeof 章号Raw === 'string' && /^[+-]?\d+$/.test(章号Raw.trim())) {
    // 纯数字字符串收敛为 number（含前导/尾随空白；合法 range 由调用方/机检把关）
    章号 = Number(章号Raw.trim())
  } else {
    return { ok: false, error: { file: filePath, line: 0, message: '章号格式不符（预期整数，实际为「' + String(章号Raw) + '」）' } }
  }
  // R31-15（三十一轮）：章号安全守卫——非正整数/超安全整数范围（`章号: -3`、
  // `章号: 99999999999999999999` 解析成 1e20）此前照收，下游比较/排序/文件名组装
  // 产生荒谬行为；与 parseChapterFileName 的 isSafeInteger 口径对齐（fail-loud，
  // 文案沿用「格式不符」便于 AI 自愈与作者改对）。
  if (!Number.isSafeInteger(章号) || 章号 < 1) {
    return { ok: false, error: { file: filePath, line: 0, message: '章号格式不符（预期正整数，实际为「' + String(章号Raw) + '」）' } }
  }

  // 收集未知字段
  const _raw: Record<string, string> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) _raw[k] = String(v)
  }

  // R73-16（二十一轮 B-3）：必填枚举（钩子类型/钩子强弱/情绪定位）缺字段此前静默补
  // 默认（悬念钩/中/铺垫），机检 fm 检对「缺失」零红项，与 draft.ts「至少包含」文案相悖。
  // 缺失清单记入 _fmMissing，checkFrontMatter 据此产红项（fm-missing）；非法值仍走
  // validateEnums（fm-enum）——「缺字段」与「写了非法值」分开呈现。空串视同缺失。
  const fmMissing: string[] = []
  const requireEnum = (key: string): void => {
    const v = map.get(key)
    if (v === undefined || v === null || v === '') fmMissing.push(key)
  }
  requireEnum('钩子类型')
  requireEnum('钩子强弱')
  requireEnum('情绪定位')

  // R41-14（四十一轮）：枚举默认值改 `||`——`??` 接不住空串，`钩子类型: ''`（手写空
  // 值）在 requireEnum 侧已记 fm-missing，值侧却穿透空串 → validateEnums 再报
  // fm-enum 越界，同字段双红矛盾（机检消费方对「缺」与「非法」的改法互斥）。空串
  // 一律落默认，红项只由 fm-missing 承载。枚举合法值均非空串，`||` 语义面精确。
  // R41-15（四十一轮）：标题单行化——块标量（`标题: |`）多行值直落会让 \n 渗进
  // ChapterMeta.标题 的全部消费面（导出载荷标题行、前端展示、警告文案；文件名侧
  // 虽有 sanitize 剥控制字符兜底，其余消费面无兜底）。读取侧各行 trim 后空格连接
  // 单行收口（folded `>` 形 parseFlat 已折成单行，literal `|` 形在此归一）。
  const chapter: ChapterMeta = {
    章号,
    标题: String(map.get('标题') ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' '),
    钩子类型: (map.get('钩子类型') as HookType) || '悬念钩',
    钩子强弱: (map.get('钩子强弱') as HookLevel) || '中',
    情绪定位: (map.get('情绪定位') as Emotion) || '铺垫',
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    ...(fmMissing.length > 0 ? { _fmMissing: fmMissing } : {}),
    _path: filePath,
    _wordCount: countWords(r.body),
    ...(includeBody ? { _body: r.body } : {}),
  }
  if (map.has('时间锚点')) chapter.时间锚点 = String(map.get('时间锚点'))
  if (map.has('场景')) chapter.场景 = map.get('场景') as SceneType
  if (map.has('字数目标')) {
    // R64-19（十二轮）：Number() 无守卫——手写「三千」→ NaN 落进元数据，区间比较
    // 恒 false 逐步污染预算/统计。非有限数按「未写」处理，走默认回落链。
    const target = Number(map.get('字数目标'))
    if (Number.isFinite(target)) chapter.字数目标 = target
  }
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
  // 走现读原实现，避免缓存大 body 占内存。默认（false）走 stat 级缓存热路径（scanChapterDir）。
  if (includeBody) return readChapterDirUncached(dirPath, includeBody)
  const { chapters, errors } = scanChapterDir(dirPath)
  return { chapters, errors }
}

/**
 * 书架摘要单轮扫描版：章数/字数/最近编辑/最新章节一次 walk 算出。
 * 与 readChapterDir 共享 scanChapterDir 的同一轮 stat 判定——书架摘要不再对每章
 * 二次 statSync（win 平台专项：同步系统调用是 GET /api/books 列表延迟的瓶颈）。
 */
export function readChapterDirSummary(dirPath: string): {
  chapters: number
  words: number
  lastEdited: string | null
  latestChapter: string | null
} {
  const { chapters, latest } = scanChapterDir(dirPath)
  const words = chapters.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  return {
    chapters: chapters.length,
    words,
    lastEdited: latest ? new Date(latest.mtimeMs).toISOString() : null,
    latestChapter: latest ? latest.title : null,
  }
}

/**
 * stat 级章节元数据缓存核心（CC-P1-3）：热路径（GET /books、GET /overview、机检、
 * 树红点聚合等）对数百章大书每轮全量 readFile+parse+countWords 会秒级阻塞事件循环。
 * 此处按 (mtimeNs,size) 判定：文件未变（绝大多数）→ 跳过整读，只 stat；变化/新增/删除
 * 由每轮 walk 自愈。R62-35：bigint stat 取 mtimeNs——与 document/tree.ts probeCache 同口径
 * （同 ms 内改回同长内容的撞车窗口收窄到 ns 级，注释同步）。
 * 返回数组与章对象均为新引用（防调用方 sort/mutate 污染缓存）；latest 在同一轮 stat 里
 * 顺带跟踪最新 mtime 的章（readChapterDirSummary 消费），不产生第二次 stat。
 */
function scanChapterDir(
  dirPath: string,
): { chapters: ChapterMeta[]; errors: ParseError[]; latest: { mtimeMs: number; no: number; title: string } | null } {
  const cache = chapterDirCache.get(dirPath) ?? new Map<string, ChapterDirEntry>()
  // R70-21：FIFO 上限——超限逐出最旧书目录（Map 插入序），防多书长跑无界缓涨
  if (!chapterDirCache.has(dirPath) && chapterDirCache.size >= CHAPTER_DIR_CACHE_MAX) {
    const oldest = chapterDirCache.keys().next().value
    if (oldest !== undefined) chapterDirCache.delete(oldest)
  }
  chapterDirCache.set(dirPath, cache)
  const chapters: ChapterMeta[] = []
  const errors: ParseError[] = []
  const seen = new Set<string>()
  let latest: { mtimeMs: number; no: number; title: string } | null = null
  // N2（五十九轮）：walk 族收口——裸 statSync（跟随 symlink）+ 无 visited 递归改走
  // walk-md 共享口径（Dirent 不跟随 symlink + realpath 剪枝 + 根界）
  walkMdEach(dirPath, (fp) => {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(fp, { bigint: true })
    } catch {
      return
    }
    const mtimeMs = Number(st.mtimeNs) / 1e6
    const hit = cache.get(fp)
    let chapter: ChapterMeta
    if (hit && hit.mtimeNs === st.mtimeNs && hit.size === st.size) {
      chapter = cloneChapter(hit.chapter) // Z-21：_raw 一并深拷贝——嵌套 mutate 不污染缓存
    } else {
      const r = readChapter(fp)
      if (!r.ok) {
        errors.push(r.error)
        cache.delete(fp) // 读失败不缓存；稳定坏文件每轮重读（错误文件罕见，可接受）
        return
      }
      cache.set(fp, { mtimeNs: st.mtimeNs, size: st.size, chapter: r.chapter })
      chapter = cloneChapter(r.chapter)
    }
    chapters.push(chapter)
    // R40-53（四十轮）：latest 决胜加章号 tie-break——快速建书/批量写章时相邻章 mtime
    // 常落同一时钟刻（win 计时器粒度），原严格 > 使先枚举者（章号小）占住 latest，
    // 「最新章」非确定（书架卡显示第59章而全书 60 章的间歇假象）。同刻按章号取大，
    // 语义即「同时刻改动的章里取最新一章」，枚举序无关。
    if (latest === null || mtimeMs > latest.mtimeMs || (mtimeMs === latest.mtimeMs && chapter.章号 > latest.no))
      latest = { mtimeMs, no: chapter.章号, title: chapter.标题 }
    seen.add(fp)
  })
  // 清理已删除文件条目（结构变化自愈：删章/移章下一轮 walk 即失效）
  for (const key of cache.keys()) {
    if (!seen.has(key)) cache.delete(key)
  }
  return { chapters, errors, latest }
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
  // N2（五十九轮）：同缓存版——walk 族收口改走 walk-md 共享口径
  walkMdEach(dirPath, (fp) => {
    const r = readChapter(fp, includeBody)
    if (r.ok) chapters.push(r.chapter)
    else errors.push(r.error)
  })
  return { chapters, errors }
}

/** CC-P1-3：章节元数据缓存条目（stat 快照 + 章元数据，不含正文）。 */
/** Z-21（第五十八轮）：缓存章元数据克隆——浅拷贝之上再拷 _raw（嵌套对象与缓存共享
 *  会让「防调用方 mutate 污染缓存」的承诺对嵌套字段不成立）；R73-16：_fmMissing 同理。 */
function cloneChapter(c: ChapterMeta): ChapterMeta {
  return {
    ...c,
    ...(c._raw !== undefined ? { _raw: { ...c._raw } } : {}),
    ...(c._fmMissing !== undefined ? { _fmMissing: [...c._fmMissing] } : {}),
  }
}

interface ChapterDirEntry {
  mtimeNs: bigint
  size: bigint
  chapter: ChapterMeta
}

/** CC-P1-3：进程级章节元数据缓存（dirPath → 文件路径 → 条目）。
 *  R70-21（十八轮）：FIFO 上限 64 书目录（probeCache 4096/树索引 16 同款纪律）——
 *  此前无上限，多书长跑缓涨（每章仅 fm 元数据 KB 级，卫生项）。 */
const CHAPTER_DIR_CACHE_MAX = 64
const chapterDirCache = new Map<string, Map<string, ChapterDirEntry>>()

/** 清空章节元数据缓存（结构性 mutation 后防御性调用；正常由每轮 walk 自愈，测试用）。 */
export function clearChapterDirCache(): void {
  chapterDirCache.clear()
}

/**
 * 内存闸（2026-08-24 审计 C2）：按 bookRoot 前缀清理章节元数据缓存——删书/改名时由
 * books.ts 接线调用（clearChapterDirCache 全清会误伤其他书的活跃条目）。外层键是
 * readChapterDir 的 dirPath 实参，全部调用方均以 join(bookRoot, …) 构造（未 resolve），
 * 故前缀匹配用 bookRoot + 平台分隔符（sep）即可字节对齐、不引入 realpath 归一（两侧
 * 同源口径，与 tree.ts invalidateTreeIndex 的 probeCache 前缀清理同款）。清后键惰性
 * 重建，无正确性影响。返回清除的外层键数（测试断言用）。
 */
export function clearChapterDirCacheForBook(bookRoot: string): number {
  const prefix = bookRoot + sep
  let removed = 0
  for (const key of chapterDirCache.keys()) {
    if (key.startsWith(prefix)) {
      chapterDirCache.delete(key)
      removed++
    }
  }
  return removed
}

// re-export 抽离到 words.ts 的纯函数（保本模块 API 不变，T2.1）
export { countWords, parseChapterFileName } from './words.js'
