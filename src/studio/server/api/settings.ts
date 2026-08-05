/**
 * 设定台 REST 端点（#7.5 P1 长篇只读 + P2 角色卡结构化读）。
 *
 * GET  /api/books/:name/settings → 境界体系 + 角色卡(结构化) + 时间线 + 关系线子图
 * GET  /api/books/:name/completion-names → 角色姓名 + 物品名称（编辑器补全用）
 *
 * P2 知识层:角色卡 front matter 约定(姓名/身份/目标/境界)+ 正文(性格/外貌/履历自由描述)。
 * 境界体系强结构化(RealmDoc);角色 P2 结构化;时间线自由 MD;关系线从账本。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, basename, relative } from 'node:path'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { route } from '../router.js'
import { reply } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readRealmDoc } from '../../../format/realms.js'
import { readLeadDir } from '../../../format/leads.js'
import { readFile, parseFlat } from '../../../format/frontmatter.js'
import type { RealmSystem } from '../../../format/types.js'

interface SettingsCtx {
  workDir: string | null
}

/** 轻量读目录下 md 文件的 fm 字段名（编辑器补全用，不读正文） */
function readFmNames(dir: string, field: string): string[] {
  const names: string[] = []
  if (!existsSync(dir)) return names
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('._'))) {
      const r = readFile(join(dir, f))
      const map = r.ok ? parseFlat(r.fmRaw) : new Map<string, unknown>()
      const n = String(map.get(field) ?? basename(f, '.md'))
      if (n) names.push(n)
    }
  } catch { /* 目录读取失败 → 空列表 */ }
  return names
}

/** 角色卡(P2 结构化):front matter 姓名/身份/目标/境界 + 正文(自由描述) */
export interface CharacterCard {
  file: string // 相对 bookRoot
  姓名: string
  身份: string
  目标: string
  境界: string
  关系: string // 原始（如 "林远(师徒);赵衡(仇敌)"）
  正文: string
}

/** 校验角色卡文件路径(防穿越:必须在 设定/角色/ 下,不含 ..,以 .md 结尾) */
export function validateCharacterFile(file: string): boolean {
  const f = normalizeProjectPath(file)
  return f.startsWith('设定/角色/') && !f.includes('..') && f.endsWith('.md')
}

function normalizeProjectPath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '')
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

  // 补全名称列表（编辑器自动补全用；轻量：角色姓名 + 物品名称，只读 fm 不读正文）
  route('GET', '/api/books/:name/completion-names', (_req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    const setDir = join(ctx.workDir, entry.path, '设定')
    reply(res, 200, {
      characters: readFmNames(join(setDir, '角色'), '姓名'),
      items: readFmNames(join(setDir, '物品'), '名称'),
    })
  })
}

function settingsLong(bookRoot: string): unknown {
  const setDir = join(bookRoot, '设定')

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

  // 关系线子图（账本关系线类）
  const { leads } = readLeadDir(join(bookRoot, '大纲', '关系线'))
  const debtGraph = leads
    .filter((l) => l.欠方 || l.债主)
    .map((l) => ({ 编号: l.编号, 标题: l.标题, 状态: l.状态, 欠方: l.欠方 ?? '', 债主: l.债主 ?? '' }))

  // 角色关系（角色卡 front matter「关系」字段 → 关系边，#7.5）
  const characterRelations: { from: string; to: string; type: string }[] = []
  for (const c of characters) {
    for (const r of parseRelations(c.关系)) {
      characterRelations.push({ from: c.姓名, to: r.to, type: r.type })
    }
  }

  return { kind: 'long' as const, realm, characters, timeline, debtGraph, characterRelations }
}

/** 解析角色卡「关系」字段 → 关系边：「林远(师徒);赵衡(仇敌)」→ [{to:林远,type:师徒}]（#7.5） */
export function parseRelations(raw: string): { to: string; type: string }[] {
  if (!raw) return []
  const out: { to: string; type: string }[] = []
  for (const part of raw.split(/[;；]/)) {
    const m = part.trim().match(/^(.+?)\((.+?)\)$/)
    if (m) out.push({ to: m[1]!.trim(), type: m[2]!.trim() })
  }
  return out
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
        file: normalizeProjectPath(relative(bookRoot, fp)),
        姓名: String(map.get('姓名') ?? basename(f, '.md')),
        身份: String(map.get('身份') ?? ''),
        目标: String(map.get('目标') ?? ''),
        境界: String(map.get('境界') ?? ''),
        关系: String(map.get('关系') ?? ''),
        正文: r.body.trim(),
      })
    } else {
      // 降级:无 front matter(旧自由 MD),姓名=文件名,正文=全文
      const text = readFileSync(fp, 'utf8')
      out.push({
        file: normalizeProjectPath(relative(bookRoot, fp)),
        姓名: basename(f, '.md'),
        身份: '',
        目标: '',
        境界: '',
        关系: '',
        正文: text.trim(),
      })
    }
  }
  return out
}

/** 组设定上下文(角色卡摘要 + 境界体系)供 outline/draft prompt 注入(RAG 第一刀:全注入,设定量可控) */
export function buildSettingsContext(bookRoot: string): string {
  const parts: string[] = []
  const chars = readCharacterCards(join(bookRoot, '设定', '角色'), bookRoot)
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
  const rr = readRealmDoc(join(bookRoot, '设定', '境界体系.md'))
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
