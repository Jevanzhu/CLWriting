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
import { isWithinRoot } from '../fs/safe-path.js'
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
}

export interface SearchOutcome {
  results: SearchHit[];
  truncated?: boolean;
}

/**
 * 全书搜索主函数。q 为空返回空结果；scope 非法回落 all。
 */
export function searchBook(bookRoot: string, q: string, scope?: string): SearchOutcome {
  const query = (q ?? '').trim()
  if (!query) return { results: [] }
  const dirs = SEARCH_SCOPE_DIRS[scope ?? 'all'] ?? SEARCH_ALL_DIRS
  const lower = query.toLowerCase()
  const results: SearchHit[] = []
  for (const dir of dirs) {
    const abs = join(bookRoot, dir)
    if (!existsSync(abs)) continue
    for (const fp of walkMd(abs, bookRoot)) {
      const matches = searchFile(fp, lower)
      if (matches.length === 0) continue
      const rel = fp.slice(bookRoot.length + 1).split('\\').join('/')
      results.push({ path: rel, matches: matches.slice(0, MAX_MATCHES_PER_FILE) })
      if (results.length >= MAX_RESULTS) {
        return { results, truncated: true }
      }
    }
  }
  return { results }
}

/** 行级 includes 匹配（大小写不敏感），返回匹配行（行号 + 截断文本）。 */
function searchFile(fp: string, lower: string): SearchMatch[] {
  let text: string
  try {
    text = readFileSync(fp, 'utf-8')
  } catch {
    return []
  }
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

