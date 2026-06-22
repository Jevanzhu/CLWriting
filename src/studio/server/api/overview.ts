/**
 * 项目总览 REST 端点（#7.2）。
 *
 * GET /api/books/:name/overview → 身份 + 进度 + 状态机位置 + 卷结构
 *
 * 状态机经 detectState（自包含：内部 rebuild index.db 幂等 + git 检查 + assembleStatus）。
 * 失败不崩（返 state:0 + 错误）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readChapterDir } from '../../../format/chapters.js'
import { detectState, STATE_NAMES, type DetectedState } from '../../../state/state.js'

interface OverviewCtx {
  workDir: string | null
}

export function registerOverviewRoutes(ctx: OverviewCtx): void {
  route('GET', '/api/books/:name/overview', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书：${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
    const kind = config.kind === 'short' ? 'short' : 'long'

    // 状态机（自包含；失败降级 state:0）
    let state: { state: number; name: string; detail: DetectedState | { error: string } }
    try {
      const detected = detectState(bookRoot, config)
      state = { state: detected.state, name: STATE_NAMES[detected.state], detail: detected }
    } catch (e) {
      state = {
        state: 0,
        name: '状态机判定失败',
        detail: { error: e instanceof Error ? e.message : String(e) },
      }
    }

    reply(res, 200, {
      identity: {
        name: entry.name,
        kind: entry.kind,
        path: entry.path,
        ...(entry.created_at ? { created_at: entry.created_at } : {}),
        title: config.book.title,
        genre: config.book.genre,
        host: config.host ?? 'cc',
      },
      progress: computeProgress(bookRoot, kind),
      state,
      volumes: kind === 'short' ? [] : listVolumes(bookRoot),
    })
  })
}

/** 进度：长篇=定稿正文章数+字数；短篇=篇/ 目录数 */
function computeProgress(bookRoot: string, kind: 'long' | 'short'): { chapters: number; words: number } {
  if (kind === 'short') {
    const piecesDir = join(bookRoot, '篇')
    if (!existsSync(piecesDir)) return { chapters: 0, words: 0 }
    let n = 0
    try {
      n = readdirSync(piecesDir).filter((x) => !x.startsWith('.')).length
    } catch {
      // 无篇目录
    }
    return { chapters: n, words: 0 }
  }
  const { chapters } = readChapterDir(join(bookRoot, '定稿', '正文'))
  const words = chapters.reduce((sum, c) => sum + (c._wordCount ?? 0), 0)
  return { chapters: chapters.length, words }
}

/** 卷结构：大纲/卷纲/*.md（长篇） */
function listVolumes(bookRoot: string): { name: string; path: string }[] {
  const dir = join(bookRoot, '大纲', '卷纲')
  if (!existsSync(dir)) return []
  const out: { name: string; path: string }[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('._')) continue
      out.push({ name: f.replace(/\.md$/, ''), path: `大纲/卷纲/${f}` })
    }
  } catch {
    // 无卷纲目录
  }
  return out
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
