/**
 * 设定台 REST 端点（#7.5 P1 长篇只读 + P2 角色卡结构化读写）。
 *
 * GET /api/books/:name/settings → 境界体系 + 角色卡(结构化) + 时间线 + 关系债子图
 * PUT /api/books/:name/settings/character  body {file, 姓名, 身份?, 目标?, 境界?, 正文}
 *   → 写回 定稿/设定/角色/<名>.md（front matter + 正文，防穿越）→ {ok, file}
 *
 * P2 知识层:角色卡 front matter 约定(姓名/身份/目标/境界)+ 正文(性格/外貌/履历自由描述)。
 * 境界体系强结构化(RealmDoc);角色 P2 结构化;时间线自由 MD;关系债从账本。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, basename, relative } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { route } from '../router.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readRealmDoc, writeRealmDoc } from '../../../format/realms.js'
import { readLeadDir } from '../../../format/leads.js'
import { readFile, parseFlat, stringifyFlat, writeFile } from '../../../format/frontmatter.js'
import type { RealmSystem } from '../../../format/types.js'

interface SettingsCtx {
  workDir: string | null
}

/** 角色卡(P2 结构化):front matter 姓名/身份/目标/境界 + 正文(自由描述) */
export interface CharacterCard {
  file: string // 相对 bookRoot
  姓名: string
  身份: string
  目标: string
  境界: string
  正文: string
}

/** 校验角色卡文件路径(防穿越:必须在 定稿/设定/角色/ 下,不含 ..,以 .md 结尾) */
export function validateCharacterFile(file: string): boolean {
  const f = file.replace(/^\/+/, '')
  return f.startsWith('定稿/设定/角色/') && !f.includes('..') && f.endsWith('.md')
}

export function registerSettingsRoutes(ctx: SettingsCtx): void {
  route('GET', '/api/books/:name/settings', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const name = params['name']
    const entry = readBooks(ctx.workDir).find((b) => b.name === name)
    if (!entry) return reply(res, 404, { error: `没有这本书:${name}` })

    const bookRoot = join(ctx.workDir, entry.path)
    const { config } = readBookConfig(join(bookRoot, 'book.yaml'))
    if (config.kind === 'short') {
      return reply(res, 200, { kind: 'short' as const, hint: '短篇无设定层(单篇内闭合)' })
    }
    reply(res, 200, settingsLong(bookRoot))
  })

  // P2 角色卡写回(防穿越:file 必须在 定稿/设定/角色/ 下)
  route('PUT', '/api/books/:name/settings/character', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const body = await readJson(req)
    const file = String(body['file'] ?? '').replace(/^\/+/, '')
    // 防穿越:必须在 定稿/设定/角色/ 下,不含 ..,以 .md 结尾
    if (!validateCharacterFile(file)) {
      return reply(res, 400, { error: 'file 必须为 定稿/设定/角色/<名>.md' })
    }
    const 姓名 = String(body['姓名'] ?? '').trim()
    if (!姓名) return reply(res, 400, { error: '姓名必填' })
    const bookRoot = join(ctx.workDir, entry.path)
    const fp = join(bookRoot, file)
    const map = new Map<string, unknown>()
    map.set('姓名', 姓名)
    if (body['身份']) map.set('身份', String(body['身份']))
    if (body['目标']) map.set('目标', String(body['目标']))
    if (body['境界']) map.set('境界', String(body['境界']))
    const 正文 = String(body['正文'] ?? '').trim()
    try {
      writeFile(fp, stringifyFlat(map), 正文)
    } catch (e) {
      return reply(res, 500, { error: `写回失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, file })
  })

  // P2 境界体系写回(固定路径 定稿/设定/境界体系.md,无 file 参数故无穿越风险)
  route('PUT', '/api/books/:name/settings/realm', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const body = await readJson(req)
    const 体系Raw = Array.isArray(body['体系']) ? (body['体系'] as unknown[]) : []
    // 规范化:名称必填,序列 string[](跳过缺名/非对象项)
    const 体系: RealmSystem[] = 体系Raw.flatMap((s): RealmSystem[] => {
      if (!s || typeof s !== 'object') return []
      const rec = s as Record<string, unknown>
      const 名称 = String(rec['名称'] ?? '').trim()
      if (!名称) return []
      return [
        {
          名称,
          序列: Array.isArray(rec['序列']) ? (rec['序列'] as unknown[]).map(String).filter((x) => x.trim() !== '') : [],
        },
      ]
    })
    const 正文 = String(body['正文'] ?? '').trim()
    const bookRoot = join(ctx.workDir, entry.path)
    const fp = join(bookRoot, '定稿', '设定', '境界体系.md')
    try {
      writeRealmDoc(fp, { 体系, _path: fp, ...(正文 ? { 正文 } : {}) })
    } catch (e) {
      return reply(res, 500, { error: `写回失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true })
  })
}

function settingsLong(bookRoot: string): unknown {
  const setDir = join(bookRoot, '定稿', '设定')

  // 境界体系（强结构化）
  let realm: { 体系: RealmSystem[]; 正文?: string } | null = null
  const rr = readRealmDoc(join(setDir, '境界体系.md'))
  if (rr.ok) {
    realm = { 体系: rr.doc.体系 }
    if (rr.doc.正文) realm.正文 = rr.doc.正文
  }

  // 角色卡(P2 结构化) / 时间线(自由 MD)
  const characters = readCharacterCards(join(setDir, '角色'), bookRoot)
  const timeline = scanFreeMd(join(setDir, '时间线'))

  // 关系债子图（账本关系债类）
  const { leads } = readLeadDir(join(bookRoot, '大纲', '关系债'))
  const debtGraph = leads
    .filter((l) => l.欠方 || l.债主)
    .map((l) => ({ 编号: l.编号, 标题: l.标题, 状态: l.状态, 欠方: l.欠方 ?? '', 债主: l.债主 ?? '' }))

  return { kind: 'long' as const, realm, characters, timeline, debtGraph }
}

/** 角色卡结构化读(P2):front matter 姓名/身份/目标/境界 + 正文;无 front matter 降级(姓名=文件名,正文=全文) */
export function readCharacterCards(dirPath: string, bookRoot: string): CharacterCard[] {
  const out: CharacterCard[] = []
  if (!existsSync(dirPath)) return out
  let files: string[]
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return out
  }
  for (const f of files) {
    const fp = join(dirPath, f)
    const r = readFile(fp)
    if (r.ok) {
      const map = parseFlat(r.fmRaw)
      out.push({
        file: relative(bookRoot, fp),
        姓名: String(map.get('姓名') ?? basename(f, '.md')),
        身份: String(map.get('身份') ?? ''),
        目标: String(map.get('目标') ?? ''),
        境界: String(map.get('境界') ?? ''),
        正文: r.body.trim(),
      })
    } else {
      // 降级:无 front matter(旧自由 MD),姓名=文件名,正文=全文
      const text = readFileSync(fp, 'utf8')
      out.push({
        file: relative(bookRoot, fp),
        姓名: basename(f, '.md'),
        身份: '',
        目标: '',
        境界: '',
        正文: text.trim(),
      })
    }
  }
  return out
}

/** 组设定上下文(角色卡摘要 + 境界体系)供 outline/draft prompt 注入(RAG 第一刀:全注入,设定量可控) */
export function buildSettingsContext(bookRoot: string): string {
  const parts: string[] = []
  const chars = readCharacterCards(join(bookRoot, '定稿', '设定', '角色'), bookRoot)
  if (chars.length) {
    parts.push(
      '## 角色设定(供参考,保持人物一致)',
      chars
        .map((c) => {
          const meta = [c.身份, c.目标, c.境界].filter(Boolean).join('/')
          return `- ${c.姓名}${meta ? `(${meta})` : ''}`
        })
        .join('\n'),
    )
  }
  const rr = readRealmDoc(join(bookRoot, '定稿', '设定', '境界体系.md'))
  if (rr.ok && rr.doc.体系.length) {
    parts.push(
      '## 境界体系(成长线机检依据)',
      rr.doc.体系.map((s) => `- ${s.名称}: ${s.序列.join(' → ')}`).join('\n'),
    )
  }
  return parts.join('\n\n')
}

/** 自由 MD 卡片扫描(时间线用):标题（首行 # 或文件名）+ 摘要（正文前 120 字） */
function scanFreeMd(dirPath: string): { 标题: string; 摘要: string }[] {
  const out: { 标题: string; 摘要: string }[] = []
  if (!existsSync(dirPath)) return out
  let files: string[]
  try {
    files = readdirSync(dirPath).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return out
  }
  for (const f of files) {
    out.push(readFreeMd(join(dirPath, f)))
  }
  return out
}

function readFreeMd(filePath: string): { 标题: string; 摘要: string } {
  let text = ''
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return { 标题: basename(filePath, '.md'), 摘要: '' }
  }
  const m = text.match(/^#\s+(.+)$/m)
  const 标题 = m ? m[1]!.trim() : basename(filePath, '.md')
  const body = text.replace(/^#[^\n]*\n?/m, '').trim()
  const 摘要 = body.slice(0, 120).trim()
  return { 标题, 摘要 }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(buf || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
