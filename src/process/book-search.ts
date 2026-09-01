/**
 * 全书 .md 扫描搜索（§19.1，YAGNI 不引 FTS）。
 *
 * 从 server/api/search.ts 抽取的服务层：行级 includes 匹配（大小写不敏感），
 * 每文件限行、总限文件防大；排除点前缀系统目录（.版本 快照/.trash 回收站/.journal）、
 * 导出/ 与 node_modules（V-P2-25，防全书搜索被历史版本与已删文件污染）。
 * 对话助手 book_search 工具与 /api/books/:name/search 端点共用，不复制逻辑。
 */
import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { readdir, readFile, stat, realpath } from 'node:fs/promises'
import { isWithinRoot } from '../fs/safe-path.js'
import { finalizedPathSet } from '../document/manifest.js'
import { clipByCodePoints } from './summary.js'

/** 可搜目录全集（相对 bookRoot） */
export const SEARCH_ALL_DIRS = ['写作/正文', '设定', '大纲', '布线', '工作区']

/** scope → 可搜目录（相对 bookRoot） */
export const SEARCH_SCOPE_DIRS: Record<string, string[]> = {
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
  path: string;
  matches: SearchMatch[];
  /** R72-9（二十轮 C-8）：该文件命中总数超过单文件上限（20）——matches 为截断视图，
   *  UI 可据此提示「仅显示前 20 处」（此前截断静默无提示） */
  hasMore?: boolean;
}

export interface SearchOutcome {
  results: SearchHit[];
  truncated?: boolean;
}

/** R26-104：bookRoot 归一化——去尾部路径分隔符；根形态（'/'、'C:\'、空串）原样返回，
 *  防止剥成 'C:'/' '\ 一类驱动器相对/退化的语义。 */
function normalizeBookRoot(bookRoot: string): string {
  const stripped = bookRoot.replace(/[\\/]+$/, '')
  if (stripped === '' || /^[a-zA-Z]:$/.test(stripped)) return bookRoot
  return stripped
}

/**
 * 全书搜索主函数。q 为空返回空结果；scope 非法回落 all。
 */
export function searchBook(bookRoot: string, q: string, scope?: string): SearchOutcome {
  // R26-104（二十六轮）：bookRoot 入参归一化（去尾部路径分隔符）后再用——rel 路径靠
  // `fp.slice(root.length + 1)` 剥前缀的算术对「根路径带尾分隔符」的入参形态敏感
  // （多剥一个字符，rel 变成「作/正文/…」式截断残串，命中结果路径错乱）。join/
  // isWithinRoot 的语义本不受尾分隔符影响，统一走归一根后两类形态等价。
  const root = normalizeBookRoot(bookRoot)
  const query = (q ?? '').trim()
  if (!query) return { results: [] }
  const dirs = SEARCH_SCOPE_DIRS[scope ?? 'all'] ?? SEARCH_ALL_DIRS
  // R73-42（二十一轮）：scope「定稿」名要符实——写作/正文 下的未定稿草稿原先一并命中，
  // 与 assembleStatus 的定稿口径（manifest.finalizedRevision 单一真相）不一致，AI 拿
  // 草稿当定稿引用会串内容。现正文区命中按 finalizedPathSet 过滤（设定/大纲等目录不受
  // 定稿基线管辖，不过滤）；清单缺失/不可读（null）无法判定 → 保持全量兜底（与
  // finalizedPathSet 的 M-2/PL-2 降级哲学一致）。
  const finalizedPaths = scope === '定稿' ? finalizedPathSet(root) : null
  const lower = query.toLowerCase()
  const results: SearchHit[] = []
  for (const dir of dirs) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    for (const fp of walkMd(abs, root)) {
      const matches = searchFile(fp, lower)
      if (matches.length === 0) continue
      const rel = fp.slice(root.length + 1).split('\\').join('/')
      // R73-42：定稿 scope 下，写作/正文 中未登记定稿基线的章（在写草稿）不进结果
      if (finalizedPaths !== null && dir === '写作/正文' && !finalizedPaths.has(rel)) continue
      // R72-9（二十轮 C-8）：文件内命中超上限时附 hasMore 标记（截断不再静默）
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

/** 行级 includes 匹配（大小写不敏感），返回匹配行（行号 + 截断文本）。 */
function matchLines(text: string, lower: string): SearchMatch[] {
  const out: SearchMatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lower)) {
      // R64-24（十二轮）：slice(0,200) 按 UTF-16 码元切——emoji/扩展区字被劈成两半
      // （落单代理对进 JSON/前端渲染均为乱码）。改码位安全截断（单源 summary.ts）。
      out.push({ line: i + 1, text: clipByCodePoints(lines[i]!, MATCH_LINE_SLICE) })
    }
  }
  return out
}

/** 行级 includes 匹配（大小写不敏感）+ 读文件；读失败（消失/权限）按无命中降级。 */
function searchFile(fp: string, lower: string): SearchMatch[] {
  let text: string
  try {
    text = readFileSync(fp, 'utf-8')
  } catch {
    return []
  }
  return matchLines(text, lower)
}

/**
 * 递归列目录下所有 .md。
 * 排除点前缀系统目录与 node_modules / 导出（V-P2-25）。
 * 低级项（第六轮）：递归前用 isWithinRoot（realpath 双侧比对）校验——书内一个指向
 * 书根外的符号链接（目录或 .md）原先会被跟随，全书检索越出 bookRoot 读到外部文件
 * （命中内容还会注入 AI 提示词）。越界 symlink 直接跳过。
 */
function walkMd(dir: string, bookRoot: string): string[] {
  const out: string[] = []
  // P5-管线（第七轮）：书内 symlink 环（a→b、b→a，isWithinRoot 拦不住环在书内的形态）
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
    // L-P5（第八轮）：显式排序——readdirSync 顺序平台相关，MAX_RESULTS 截断后
    // 「同一书库不同机器搜出不同前 50 条」；排序后截断结果确定
    entries.sort()
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules' || name === '导出') continue
      const p = join(d, name)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (!isWithinRoot(bookRoot, p)) continue // 越界 symlink 跳过（fail-closed）
      if (s.isDirectory()) walk(p)
      else if (name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * searchBook 的异步孪生（R35-7，三十五轮）——HTTP 全书搜索端点专用：全链 fs.promises
 * （readdir/readFile/stat/realpath，realpath 语义逐位保留），扫描期间事件循环可响应
 * SSE 心跳/保存等其他请求（同步版 readFileSync/walkMd 全程阻塞，端点上不再使用）。
 * 匹配/排序/截断/排除目录/symlink 纪律与同步版逐位同源（matchLines 单源共享）；
 * 同步版保留给 AI book_search 工具（子进程面，无事件循环冻结问题），不复制逻辑漂移。
 */
export async function searchBookAsync(bookRoot: string, q: string, scope?: string): Promise<SearchOutcome> {
  // 归一/过滤/截断口径与 searchBook 逐位对齐（见同步版各行注释，此处不重复）
  const root = normalizeBookRoot(bookRoot)
  const query = (q ?? '').trim()
  if (!query) return { results: [] }
  const dirs = SEARCH_SCOPE_DIRS[scope ?? 'all'] ?? SEARCH_ALL_DIRS
  const finalizedPaths = scope === '定稿' ? finalizedPathSet(root) : null
  const lower = query.toLowerCase()
  const results: SearchHit[] = []
  for (const dir of dirs) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    // 顺序 await（非并发池）：保住同步版「排序后按序截断」的确定性口径
    for (const fp of await walkMdAsync(abs, root)) {
      const matches = await searchFileAsync(fp, lower)
      if (matches.length === 0) continue
      const rel = fp.slice(root.length + 1).split('\\').join('/')
      if (finalizedPaths !== null && dir === '写作/正文' && !finalizedPaths.has(rel)) continue
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

/** searchFile 异步孪生：读失败（消失/权限）同款按无命中降级。 */
async function searchFileAsync(fp: string, lower: string): Promise<SearchMatch[]> {
  let text: string
  try {
    text = await readFile(fp, 'utf-8')
  } catch {
    return []
  }
  return matchLines(text, lower)
}

/**
 * walkMd 异步孪生：排除点前缀/node_modules/导出、realpath 环剪枝、越界 symlink
 * fail-closed、显式排序——纪律逐位同源（见同步版注释）。
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
      if (name.startsWith('.') || name === 'node_modules' || name === '导出') continue
      const p = join(d, name)
      let s
      try {
        s = await stat(p)
      } catch {
        continue
      }
      if (!isWithinRoot(bookRoot, p)) continue // 越界 symlink 跳过（fail-closed）
      if (s.isDirectory()) await walk(p)
      else if (name.endsWith('.md')) out.push(p)
    }
  }
  await walk(dir)
  return out
}

