/**
 * 搜索端点（§19.1，W2A 收尾）：全书 .md 扫描，YAGNI 不引 FTS。
 *
 * GET /api/books/:name/search?q=&scope=all|定稿|设定|大纲|工作区
 *   → { results: [{path, matches: [{line, text}]}], truncated? }
 *
 * 行级 includes 匹配（大小写不敏感）；每文件限 N 行、总限 N 文件防大。
 * UI 面板归 M3（W2 只做 core 端点，方案 §4 决策 4）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'

interface SearchCtx {
  workDir: string | null
}

/** 可搜目录全集（相对 bookRoot） */
const ALL_DIRS = ['定稿/正文', '定稿/设定', '大纲', '工作区']

/** scope → 可搜目录（相对 bookRoot） */
const SCOPE_DIRS: Record<string, string[]> = {
  all: ALL_DIRS,
  定稿: ['定稿/正文', '定稿/设定'],
  正文: ['定稿/正文'],
  设定: ['定稿/设定'],
  大纲: ['大纲'],
  工作区: ['工作区'],
}

const MAX_MATCHES_PER_FILE = 20
const MAX_RESULTS = 50
const MATCH_LINE_SLICE = 200

export function registerSearchRoutes(ctx: SearchCtx): void {
  route('GET', '/api/books/:name/search', (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书：${params['name']}` })

    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = (url.searchParams.get('q') ?? '').trim()
    if (!q) return reply(res, 200, { results: [] })
    const scope = url.searchParams.get('scope') ?? 'all'
    const dirs = SCOPE_DIRS[scope] ?? ALL_DIRS

    const bookRoot = join(ctx.workDir, entry.path)
    const lower = q.toLowerCase()
    const results: { path: string; matches: { line: number; text: string }[] }[] = []
    for (const dir of dirs) {
      const abs = join(bookRoot, dir)
      if (!existsSync(abs)) continue
      for (const fp of walkMd(abs)) {
        const matches = searchFile(fp, lower)
        if (matches.length === 0) continue
        const rel = fp.slice(bookRoot.length + 1).split('\\').join('/')
        results.push({ path: rel, matches: matches.slice(0, MAX_MATCHES_PER_FILE) })
        if (results.length >= MAX_RESULTS) {
          return reply(res, 200, { results, truncated: true })
        }
      }
    }
    reply(res, 200, { results })
  })
}

/** 行级 includes 匹配（大小写不敏感），返回匹配行（行号 + 截断文本） */
function searchFile(fp: string, lower: string): { line: number; text: string }[] {
  let text: string
  try {
    text = readFileSync(fp, 'utf-8')
  } catch {
    return []
  }
  const out: { line: number; text: string }[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.toLowerCase().includes(lower)) {
      out.push({ line: i + 1, text: lines[i]!.slice(0, MATCH_LINE_SLICE) })
    }
  }
  return out
}

/** 递归列目录下所有 .md（排除 ._ / node_modules / .git） */
function walkMd(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith('._') || name === 'node_modules' || name === '.git') continue
      const p = join(d, name)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) walk(p)
      else if (name.endsWith('.md')) out.push(p)
    }
  }
  walk(dir)
  return out
}
