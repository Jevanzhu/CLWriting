/**
 * 全书 .md 扫描搜索（§19.1，YAGNI 不引 FTS）。
 *
 * 从 server/api/search.ts 抽取的服务层：行级 includes 匹配（大小写不敏感），
 * 每文件限行、总限文件防大；排除点前缀系统目录（.版本 快照/.trash 回收站/.journal）、
 * 导出/ 与 node_modules（防全书搜索被历史版本与已删文件污染）、spills/（
 * 防 AI 全文快照副本双出处命中）；.md 判定大小写不敏感（.MD 漏网）。
 * 对话助手 book_search 工具与 /api/books/:name/search 端点共用，不复制逻辑。
 *
 * 全链 fs.promises（readdir/readFile/stat/realpath）：本函数跑在 studio 服务进程的
 * 事件循环内（HTTP 端点与 chat 工具同用），同步扫描会把同进程全部书的 SSE 心跳与
 * 保存在扫描期间一并冻住。行为契约：归一、query 解析、dirs、finalizedKeys 折叠、
 * 截断上限、排除规则。
 */
import { join, relative } from 'node:path'
import { readdir, stat, realpath } from 'node:fs/promises'
import { isWithinRoot, docJoinKey, normalizeWinSeparators } from '../fs/safe-path.js'
import { readMdTextCachedAsync } from '../fs/md-text-cache.js'
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

/** 搜索计划：前奏解析产物。 */
interface SearchPlan {
  root: string
  /** 已 toLowerCase 的查询串 */
  lower: string
  dirs: string[]
  /** null = 非「定稿」scope（不过滤）；否则定稿集折叠键集（docJoinKey，win32 大小写 + NFC） */
  finalizedKeys: Set<string> | null
}

/** 前奏解析。空查询返 null（调用方早退 { results: [] }）。 */
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
  // finalizedPathSet 的降级哲学一致）。
  const finalizedPaths = scope === '定稿' ? finalizedPathSet(root) : null
  // 定稿集消费侧折叠键集（win32 大小写 + NFC，overview.ts
  // 同款范式——set 构建一次）——case-only 改名 / NFD 文件名后精确串失配，定稿章
  // 从「定稿」scope 结果里漏掉（AI 引用面失真）
  const finalizedKeys = finalizedPaths === null ? null : new Set([...finalizedPaths].map(docJoinKey))
  return { root, lower: query.toLowerCase(), dirs, finalizedKeys }
}

/**
 * 全书搜索主函数。q 为空返回空结果；scope 非法回落 all。
 *
 * 逐目录「列文件 → 逐文件读文」顺序推进（非并发池）：单文件/总量截断在命中序上截，
 * 并发读写会让「截断到哪一条」随 IO 完成序漂移，同书同参数搜出不同前 50 条。
 */
export async function searchBookAsync(bookRoot: string, q: string, scope?: string): Promise<SearchOutcome> {
  const plan = buildSearchPlan(bookRoot, q, scope)
  if (plan === null) return { results: [] }
  const { root, lower, dirs, finalizedKeys } = plan
  const results: SearchHit[] = []
  for (const dir of dirs) {
    // 目录缺失无需预判：walker 对不存在/不可解析起点 realpath 失败即空返
    //（见 walkMdAsync），空列表 → 该 scope 零命中。
    const files = await walkMdAsync(join(root, dir), root)
    for (const fp of files) {
      const text = await readMdTextCachedAsync(fp)
      // 读失败（消失/权限）按无命中降级
      if (text === null) continue
      const matches = matchLines(text, lower)
      if (matches.length === 0) continue
      // rel 用 relative 派生——`slice(root.length + 1)` 算术对根形态
      //（'/'、'C:\'特意保留不归一）恒吃掉 rel 首字符（命中路径截断残串）；
      // relative 语义对全部根形态正确，常规形态产出逐字节不变
      // mac适配：分隔符归一收窄 win32-only（normalizeWinSeparators 单源，
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

/**
 * 递归列目录下所有 .md。
 * 排除点前缀系统目录与 node_modules / 导出 / spills。
 * 低级项：递归前用 isWithinRoot（realpath 双侧比对）校验——书内一个指向
 * 书根外的符号链接（目录或 .md）原先会被跟随，全书检索越出 bookRoot 读到外部文件
 * （命中内容还会注入 AI 提示词）。越界 symlink 直接跳过。
 */
async function walkMdAsync(dir: string, bookRoot: string): Promise<string[]> {
  const out: string[] = []
  // 管线：书内 symlink 环（a→b、b→a，isWithinRoot 拦不住环在书内的形态）
  // 会让递归无限下行栈溢出——以 realpath 为键记录已访目录，二次进入剪枝
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
    // 显式排序——readdir 顺序平台相关，MAX_RESULTS 截断后
    // 「同一书库不同机器搜出不同前 50 条」；排序后截断结果确定
    entries.sort()
    for (const name of entries) {
      // 排除 spills——工作区全文快照（AI 会话临时副本，哈希文件名）
      // 与正本同文，全书搜索会双出处命中且其一指向内部缓存路径
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
      else if (name.slice(-3).toLowerCase() === '.md') out.push(p) // .MD 大写漏网（win 手改扩展名常态）
    }
  }
  await walk(dir)
  return out
}
