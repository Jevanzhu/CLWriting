/**
 * 全书 .md 扫描搜索（§19.1，YAGNI 不引 FTS）。
 *
 * 从 server/api/search.ts 抽取的服务层：行级 includes 匹配（大小写不敏感），
 * 每文件限行、总限文件防大；排除点前缀系统目录（.版本 快照/.trash 回收站/.journal）、
 * 导出/ 与 node_modules（防全书搜索被历史版本与已删文件污染）、spills/（
 * 防 AI 全文快照副本双出处命中）；.md 判定大小写不敏感（.MD 漏网）。
 * 对话助手 book_search 工具与 /api/books/:name/search 端点共用，不复制逻辑。
 *
 * （-0914）单源化：searchBook/searchBookAsync 原手写平行双轨（前奏解析/
 * 逐目录循环/逐文件命中折叠/截断各一份），对齐 collectTreeIssuesCore 仓内范式
 * （check/run.ts ，生成器核心 + 同步/异步双驱动）收编单源——
 * - buildSearchPlan：前奏解析（归一/query 解析/dirs/finalizedKeys 折叠）一次写就；
 * - searchBookCore：生成器核心持有目录循环与逐文件命中折叠（rel 派生/定稿过滤/
 *   单文件截断/总量截断），IO 经 SearchFileIo 注入（yield 交驱动取值/等待）；
 * - 双驱动：同步侧 walkMd + readMdTextCached（直返值），异步侧 walkMdAsync +
 *   readMdTextCachedAsync（fs.promises），匹配/排序/截断/排除纪律零复制。
 * 行为逐位不变：六要素（归一、query 解析、dirs、finalizedKeys 折叠、截断上限、
 * 排除规则）两侧与改前完全一致。
 */
import { join, relative } from 'node:path'
import { readdirSync, statSync, realpathSync } from 'node:fs'
import { readdir, stat, realpath } from 'node:fs/promises'
import { isWithinRoot, docJoinKey, normalizeWinSeparators } from '../fs/safe-path.js'
import { readMdTextCached, readMdTextCachedAsync } from '../fs/md-text-cache.js'
import { finalizedPathSet } from '../document/manifest.js'
// 码点截断直引实现所在模块（原经 ./summary.js 的 re-export 中转，已剥除）
import { clipByCodePoints } from '../shared/text.js'

/** 可搜目录全集（相对 bookRoot） */
export const SEARCH_ALL_DIRS = ['写作/正文', '设定', '大纲', '布线', '工作区']

/** scope → 可搜目录（相对 bookRoot） */
const SEARCH_SCOPE_DIRS: Record<string, string[]> = {
  all: SEARCH_ALL_DIRS,
  定稿: ['写作/正文', '设定'],
  正文: ['写作/正文'],
  设定: ['设定'],
  大纲: ['大纲'],
  工作区: ['工作区'],
}

const MAX_MATCHES_PER_FILE = 20
const MAX_RESULTS = 50
const MATCH_LINE_SLICE = 200

export interface SearchMatch {
  line: number
  text: string
}

export interface SearchHit {
  /** 相对 bookRoot 的路径（正斜杠） */
  path: string
  matches: SearchMatch[]
  /** 该文件命中总数超过单文件上限（20）——matches 为截断视图，
   *  UI 可据此提示「仅显示前 20 处」（此前截断静默无提示） */
  hasMore?: boolean
}

export interface SearchOutcome {
  results: SearchHit[]
  truncated?: boolean
}

/** bookRoot 归一化——去尾部路径分隔符；根形态（'/'、'C:\'、空串）原样返回，
 *  防止剥成 'C:'/' '\ 一类驱动器相对/退化的语义。 */
function normalizeBookRoot(bookRoot: string): string {
  const stripped = bookRoot.replace(/[\\/]+$/, '')
  if (stripped === '' || /^[a-zA-Z]:$/.test(stripped)) return bookRoot
  return stripped
}

/** 行级 includes 匹配（大小写不敏感），返回匹配行（行号 + 截断文本）。 */
function matchLines(text: string, lower: string): SearchMatch[] {
  const out: SearchMatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lower)) {
      // slice(0,200) 按 UTF-16 码元切——emoji/扩展区字被劈成两半
      // （落单代理对进 JSON/前端渲染均为乱码）。改码位安全截断（单源 summary.ts）。
      out.push({ line: i + 1, text: clipByCodePoints(lines[i]!, MATCH_LINE_SLICE) })
    }
  }
  return out
}

// ── （-0914）：单源核心 + 双驱动 ─────────────────────────────

/** 搜索计划：前奏解析产物（同步/异步双驱动共用，六要素之前四——归一/query 解析/
 *  dirs/finalizedKeys 折叠；截断上限内聚于核心、排除规则内聚于 walker）。 */
interface SearchPlan {
  root: string
  /** 已 toLowerCase 的查询串 */
  lower: string
  dirs: string[]
  /** null = 非「定稿」scope（不过滤）；否则定稿集折叠键集（docJoinKey，win32 大小写 + NFC） */
  finalizedKeys: Set<string> | null
}

/** 前奏解析（原 searchBook/searchBookAsync 双侧复写的开头段收编单源）。
 *  空查询返 null（调用方早退 { results: [] }，与改前逐位一致）。 */
function buildSearchPlan(bookRoot: string, q: string, scope?: string): SearchPlan | null {
  // bookRoot 入参归一化（去尾部路径分隔符）后再用——rel 路径靠
  // `fp.slice(root.length + 1)` 剥前缀的算术对「根路径带尾分隔符」的入参形态敏感
  // （多剥一个字符，rel 变成「作/正文/…」式截断残串，命中结果路径错乱）。join/
  // isWithinRoot 的语义本不受尾分隔符影响，统一走归一根后两类形态等价。
  const root = normalizeBookRoot(bookRoot)
  const query = (q ?? '').trim()
  if (!query) return null
  const dirs = SEARCH_SCOPE_DIRS[scope ?? 'all'] ?? SEARCH_ALL_DIRS
  // scope「定稿」名要符实——写作/正文 下的未定稿草稿原先一并命中，
  // 与 assembleStatus 的定稿口径（manifest.finalizedRevision 单一真相）不一致，AI 拿
  // 草稿当定稿引用会串内容。现正文区命中按 finalizedPathSet 过滤（设定/大纲等目录不受
  // 定稿基线管辖，不过滤）；清单缺失/不可读（null）无法判定 → 保持全量兜底（与
  // finalizedPathSet 的 /PL-2 降级哲学一致）。
  const finalizedPaths = scope === '定稿' ? finalizedPathSet(root) : null
  // /：定稿集消费侧折叠键集（win32 大小写 + NFC，overview.ts
  // 同款范式——set 构建一次）——case-only 改名 / NFD 文件名后精确串失配，定稿章
  // 从「定稿」scope 结果里漏掉（AI 引用面失真）
  const finalizedKeys = finalizedPaths === null ? null : new Set([...finalizedPaths].map(docJoinKey))
  return { root, lower: query.toLowerCase(), dirs, finalizedKeys }
}

/** 逐文件 IO 面（同步/异步双实现注入）。同步侧返回值恒非 Promise
 *  （walkMd/readMdTextCached 直返），异步侧为 fs.promises 孪生；生成器核心对两侧
 *  一视同仁（yield 交驱动取值/等待），匹配/过滤/截断逻辑单源不再双侧复写。
 *  口径随实现保留：文件读取走 fs/md-text-cache.ts stat 指纹缓存
 *  （读失败返回 null 按无命中降级），异步孪生与同步版共享同一指纹表。
 *  0918修复批（C005）：listMd 契约本就覆盖目录缺失——两驱动侧 walk 对不存在
 *  起点 realpath 失败空返，核心内目录存在性预判（原 existsSync）随批删除。 */
interface SearchFileIo {
  /** 列目录下全部 .md（排除/排序/symlink 纪律内聚在 walker，见 walkMd 注） */
  listMd(dir: string): string[] | Promise<string[]>
  /** 读文件全文；读失败（消失/权限）→ null（核心按无命中降级） */
  readText(fp: string): string | null | Promise<string | null>
}

/** 搜索实现体（生成器，单源供同步/异步双驱动）。目录循环、读失败降级、
 *  rel 派生、定稿过滤、单文件/总量截断的口径全部只写这一份。 */
function* searchBookCore(plan: SearchPlan, io: SearchFileIo): Generator<unknown, SearchOutcome, unknown> {
  const { root, lower, dirs, finalizedKeys } = plan
  const results: SearchHit[] = []
  for (const dir of dirs) {
    const abs = join(root, dir)
    // 0918修复批（C005）：目录存在性预判删——existsSync 是双驱动核心内最后的
    // 同步 IO 残留（异步侧「全链 fs.promises」宣称自此逐字成立）。语义由注入的
    // SearchFileIo 天然覆盖：listMd 两驱动侧 walk 对不存在/不可解析起点 realpath 失败
    // 即空返（见 walkMd/walkMdAsync），空列表 → 该 scope 零命中，与原 continue 等价。
    const files = (yield io.listMd(abs)) as string[]
    for (const fp of files) {
      const text = (yield io.readText(fp)) as string | null
      // 读失败（消失/权限）按无命中降级（原 searchFile/searchFileAsync 同口径）
      if (text === null) continue
      const matches = matchLines(text, lower)
      if (matches.length === 0) continue
      // rel 改 relative 派生——`slice(root.length + 1)` 算术对根形态
      //（'/'、'C:\'，特意保留不归一）恒吃掉 rel 首字符（命中路径截断残串）；
      // relative 语义对全部根形态正确，常规形态产出逐字节不变
      // -mac适配：分隔符归一收窄 win32-only（normalizeWinSeparators 单源，
      // 与 manifest/state 侧同口径）——posix 上字面 `\` 文件名保持原样进 docJoinKey
      const rel = normalizeWinSeparators(relative(root, fp))
      // 定稿 scope 下，写作/正文 中未登记定稿基线的章（在写草稿）不进结果
      if (finalizedKeys !== null && dir === '写作/正文' && !finalizedKeys.has(docJoinKey(rel))) continue // 折叠键比较
      // 文件内命中超上限时附 hasMore 标记（截断不再静默）
      results.push({
        path: rel,
        matches: matches.slice(0, MAX_MATCHES_PER_FILE),
        ...(matches.length > MAX_MATCHES_PER_FILE ? { hasMore: true } : {}),
      })
      if (results.length >= MAX_RESULTS) {
        return { results, truncated: true }
      }
    }
  }
  return { results }
}

/** 同步驱动——同步面 IO 恒非 Promise，yield 产出直取回传（collectTreeIssuesCore
 *  同款：yield 只把控制权交还本驱动随即 next 续跑，净效果与纯同步执行逐位一致）。 */
function driveSearchCoreSync(it: Generator<unknown, SearchOutcome, unknown>): SearchOutcome {
  let input: unknown
  for (;;) {
    const r = it.next(input)
    if (r.done) return r.value
    input = r.value
  }
}

/**
 * 全书搜索主函数。q 为空返回空结果；scope 非法回落 all。
 * 起为生成器核心的同步驱动（walkMd + readMdTextCached），行为与改前逐位一致。
 */
export function searchBook(bookRoot: string, q: string, scope?: string): SearchOutcome {
  const plan = buildSearchPlan(bookRoot, q, scope)
  if (plan === null) return { results: [] }
  return driveSearchCoreSync(
    searchBookCore(plan, {
      listMd: (d) => walkMd(d, plan.root),
      readText: (fp) => readMdTextCached(fp),
    }),
  )
}

/**
 * searchBook 的异步孪生——原 HTTP 全书搜索端点专用，
 * 起 AI book_search 工具同用（chat 工具在 studio 服务进程事件循环内执行，同步版会冻结
 * 同进程全部书的 SSE/保存）：全链 fs.promises（readdir/readFile/stat/realpath，realpath
 * 语义逐位保留），扫描期间事件循环可响应 SSE 心跳/保存等其他请求。匹配/排序/截断/排除
 * 目录/symlink 纪律与同步版逐位同源（起经 searchBookCore 单源，不再靠双侧对齐）。
 * 「全链 fs.promises」宣称 0918修复批（C005）起逐字成立：生成器核心内最后的
 * 同步残留 existsSync 目录预判随批删除（listMd 对不存在目录空返天然覆盖，见 SearchFileIo 注）。
 * 同步版 searchBook 现仅测试面/CLI 面消费，生产读路径一律走本异步版（口径更正：
 * 旧注「同步版保留给 AI book_search 工具（子进程面）」是 spawn CLI 时代的过时口径）。
 */
export async function searchBookAsync(bookRoot: string, q: string, scope?: string): Promise<SearchOutcome> {
  const plan = buildSearchPlan(bookRoot, q, scope)
  if (plan === null) return { results: [] }
  // 异步驱动：逐 yield await（顺序非并发池，保住同步版「排序后按序截断」的确定性口径）
  const it = searchBookCore(plan, {
    listMd: (d) => walkMdAsync(d, plan.root),
    readText: (fp) => readMdTextCachedAsync(fp),
  })
  let input: unknown
  for (;;) {
    const r = it.next(input)
    if (r.done) return r.value
    input = await r.value
  }
}

/**
 * 递归列目录下所有 .md（同步侧 walk 驱动）。
 * 排除点前缀系统目录与 node_modules / 导出。
 * 低级项：递归前用 isWithinRoot（realpath 双侧比对）校验——书内一个指向
 * 书根外的符号链接（目录或 .md）原先会被跟随，全书检索越出 bookRoot 读到外部文件
 * （命中内容还会注入 AI 提示词）。越界 symlink 直接跳过。
 */
function walkMd(dir: string, bookRoot: string): string[] {
  const out: string[] = []
  // -管线：书内 symlink 环（a→b、b→a，isWithinRoot 拦不住环在书内的形态）
  // 会让递归无限下行栈溢出——以 realpath 为键记录已访目录，二次进入剪枝
  const visited = new Set<string>()
  const walk = (d: string): void => {
    let real: string
    try {
      real = realpathSync(d)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    // L-：显式排序——readdirSync 顺序平台相关，MAX_RESULTS 截断后
    // 「同一书库不同机器搜出不同前 50 条」；排序后截断结果确定
    entries.sort()
    for (const name of entries) {
      // 排除 spills——工作区全文快照（AI 会话临时副本，哈希文件名）
      // 与正本同文，全书搜索会双出处命中且其一指向内部缓存路径
      if (name.startsWith('.') || name === 'node_modules' || name === '导出' || name === 'spills') continue
      const p = join(d, name)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (!isWithinRoot(bookRoot, p)) continue // 越界 symlink 跳过（fail-closed）
      if (s.isDirectory()) walk(p)
      else if (name.slice(-3).toLowerCase() === '.md') out.push(p) // .MD 大写漏网（win 手改扩展名常态）
    }
  }
  walk(dir)
  return out
}

/**
 * walkMd 异步孪生（异步侧 walk 驱动）：排除点前缀/node_modules/导出、realpath
 * 环剪枝、越界 symlink fail-closed、显式排序——纪律逐位同源（见同步版注释）。
 */
async function walkMdAsync(dir: string, bookRoot: string): Promise<string[]> {
  const out: string[] = []
  const visited = new Set<string>()
  const walk = async (d: string): Promise<void> => {
    let real: string
    try {
      real = await realpath(d)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)
    let entries: string[]
    try {
      entries = await readdir(d)
    } catch {
      return
    }
    entries.sort()
    for (const name of entries) {
      // /：与同步版同口径（spills 排除 + .md 大小写不敏感）
      if (name.startsWith('.') || name === 'node_modules' || name === '导出' || name === 'spills') continue
      const p = join(d, name)
      let s
      try {
        s = await stat(p)
      } catch {
        continue
      }
      if (!isWithinRoot(bookRoot, p)) continue // 越界 symlink 跳过（fail-closed）
      if (s.isDirectory()) await walk(p)
      else if (name.slice(-3).toLowerCase() === '.md') out.push(p)
    }
  }
  await walk(dir)
  return out
}
