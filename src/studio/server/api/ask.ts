/**
 * 设定问答端点（问书）：
 *
 * POST /api/books/:name/ask  body { question }
 *   → 读 定稿/设定/ 全部 .md → 拼 prompt → spawnRole('world-advisor') → 返回答案
 *
 * 设定文件通常几十 KB，直接全量拼进 prompt（不需要 RAG）。
 * AI 不可达时前端置灰（G4），不调此端点。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { route } from '../router.js'
import { readJson, reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { getDriver } from '../../../driver/index.js'
import type { DriverEvent } from '../../../driver/types.js'

interface AskCtx {
  workDir: string | null
}

/** 设定文件最大总量（字符数）；超出按优先级截断防 prompt 过大 */
const MAX_SETTINGS_CHARS = 30000

export function registerAskRoutes(ctx: AskCtx): void {
  route('POST', '/api/books/:name/ask', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { ok: false, error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { ok: false, error: `没有这本书：${params['name']}` })
    const body = await readJson(req)
    const question = String(body['question'] ?? '').trim()
    if (!question) return reply(res, 400, { ok: false, error: '问题不能为空' })

    const bookRoot = join(ctx.workDir, entry.path)
    const settingsDir = join(bookRoot, '定稿', '设定')
    if (!existsSync(settingsDir)) {
      return reply(res, 200, { ok: true, answer: '设定目录为空——还没有设定文件。先在「定稿/设定/」建角色卡或世界观。' })
    }

    // 读全部设定文件，拼成 context
    const files = collectSettings(settingsDir)
    if (files.length === 0) {
      return reply(res, 200, { ok: true, answer: '没有找到设定文件。先在「定稿/设定/」建角色卡或世界观。' })
    }

    const context = formatSettings(files)
    const prompt = [
      '## 你的角色',
      '你是世界观顾问。基于作者提供的设定资料回答问题。',
      '设定未提及的内容诚实回答「设定中未提及」，绝不编造。',
      '回答简洁精准，可引用来源（哪个文件）。',
      '',
      '## 设定资料',
      context,
      '',
      '## 作者提问',
      question,
    ].join('\n')

    // spawnRole 收集回答（同 rewrite 模式：start → spawn → stream → dispose）
    const driver = getDriver('cc')
    const session = await driver.startSession(ctx.workDir)
    driver.spawnRole(session, 'world-advisor', prompt)
    let text = ''
    try {
      for await (const ev of driver.stream(session) as AsyncGenerator<DriverEvent>) {
        if (ev.type === 'text') text += String(ev.text ?? '')
        else if (ev.type === 'done') break
        else if (ev.type === 'error') {
          driver.dispose(session)
          return reply(res, 500, { ok: false, error: `driver:${ev.message}` })
        }
      }
    } catch (e) {
      driver.dispose(session)
      return reply(res, 500, { ok: false, error: `stream:${e instanceof Error ? e.message : String(e)}` })
    }
    driver.dispose(session)

    const answer = text.trim()
    if (!answer) return reply(res, 500, { ok: false, error: 'AI 未返回内容' })
    reply(res, 200, { ok: true, answer })
  })
}

/** 递归收集设定目录下所有 .md 文件（排除 ._ / node_modules / .git） */
function collectSettings(dir: string): { rel: string; content: string }[] {
  const out: { rel: string; content: string }[] = []
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
      else if (name.endsWith('.md')) {
        try {
          out.push({ rel: p.slice(dir.length + 1).split('\\').join('/'), content: readFileSync(p, 'utf-8') })
        } catch {
          /* 读失败跳过 */
        }
      }
    }
  }
  walk(dir)
  return out
}

/** 格式化设定文件为 prompt context（带文件名标签 + 截断保护） */
function formatSettings(files: { rel: string; content: string }[]): string {
  let total = 0
  const parts: string[] = []
  for (const f of files) {
    const size = f.content.length
    if (total + size > MAX_SETTINGS_CHARS) {
      const remaining = MAX_SETTINGS_CHARS - total
      if (remaining > 100) {
        parts.push(`### ${f.rel}\n${f.content.slice(0, remaining)}\n…（已截断）`)
      }
      break
    }
    parts.push(`### ${f.rel}\n${f.content}`)
    total += size
  }
  return parts.join('\n\n')
}
