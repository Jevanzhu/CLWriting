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
import { join, basename, relative, dirname } from 'node:path'
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { route } from '../router.js'
import { reply, readJson } from '../http.js'
import { readBooks } from '../../../install/books.js'
import { readBookConfig } from '../../../format/yaml.js'
import { readRealmDoc } from '../../../format/realms.js'
import { readLeadDir } from '../../../format/leads.js'
import { readFile, parseFlat } from '../../../format/frontmatter.js'
import { atomicWriteFile } from '../../../fs/atomic.js'
import { runSpec } from '../../../ai/tasks/spec.js'
import { RELATION_MINE_SPEC } from '../../../ai/tasks/specs.js'
import type { RealmSystem } from '../../../format/types.js'

interface SettingsCtx {
  workDir: string | null
  userDataPath: string | null
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

  // AI 关系梳理：通读名册/角色卡/正文，提炼关系边 → 落盘 .clwriting/relations.json
  route('POST', '/api/books/:name/relations/mine', async (req: IncomingMessage, res: ServerResponse, params) => {
    if (!ctx.workDir) return reply(res, 400, { error: '未定位到工作目录' })
    const entry = readBooks(ctx.workDir).find((b) => b.name === params['name'])
    if (!entry) return reply(res, 404, { error: `没有这本书:${params['name']}` })
    // 幂等：body.force=true 强制重新梳理；否则已有缓存则直接返回
    const body = (await readJson(req).catch(() => ({}))) as { force?: boolean }
    const force = body?.force === true
    const bookRoot = join(ctx.workDir, entry.path)
    const cachePath = join(bookRoot, RELATION_CACHE)
    if (!force && existsSync(cachePath)) {
      return reply(res, 200, { ok: true, cached: true, relations: readMinedRelations(bookRoot) })
    }
    const context = buildMineContext(bookRoot)
    if (!context.trim()) return reply(res, 400, { error: '没有可梳理的材料（名册/角色卡/正文均空）' })
    const out = await runSpec(RELATION_MINE_SPEC, {
      userDataPath: ctx.userDataPath,
      bookRoot,
      userPrompt: `## 任务\n通读以下材料，提炼这部书的角色关系网络。\n\n${context}`,
    })
    if (!out.ok) return reply(res, 500, { error: `AI 梳理失败:${out.error}` })
    const input = out.data.input as { relations?: { from: string; to: string; type: string; note?: string }[] } | null
    const relations = input?.relations ?? []
    if (!relations.length) return reply(res, 200, { ok: true, cached: true, relations: [] })
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      atomicWriteFile(cachePath, JSON.stringify({ relations }, null, 2))
    } catch (e) {
      return reply(res, 500, { error: `落盘缓存失败:${e instanceof Error ? e.message : String(e)}` })
    }
    reply(res, 200, { ok: true, cached: false, relations })
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

  // 角色关系：AI 梳理缓存（.clwriting/relations.json，优先）+ 角色卡 front matter「关系」字段（补充）
  const mined = readMinedRelations(bookRoot) // [{from,to,type,note?}]
  const seen = new Set<string>()
  const pushEdge = (from: string, to: string, type: string): void => {
    if (!from || !to || from === to) return
    const k = from < to ? `${from} ${to}` : `${to} ${from}`
    if (seen.has(k)) return
    seen.add(k)
    characterRelations.push({ from, to, type: normalizeRelationType(type) })
  }
  const characterRelations: { from: string; to: string; type: string }[] = []
  for (const e of mined) pushEdge(e.from, e.to, e.type)
  for (const c of characters) {
    for (const r of parseRelations(c.关系)) pushEdge(c.姓名, r.to, r.type)
  }

  return { kind: 'long' as const, realm, characters, timeline, debtGraph, characterRelations }
}

/** AI 关系梳理缓存的相对路径（.clwriting/relations.json）。 */
const RELATION_CACHE = '.clwriting/relations.json'

/** 读 AI 关系梳理缓存（不存在/损坏 → 空数组）。 */
function readMinedRelations(bookRoot: string): { from: string; to: string; type: string; note?: string }[] {
  try {
    const p = join(bookRoot, RELATION_CACHE)
    if (!existsSync(p)) return []
    const d = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(d?.relations)) return []
    return d.relations.filter(
      (e: unknown): e is { from: string; to: string; type: string; note?: string } =>
        !!e && typeof (e as { from?: unknown }).from === 'string' &&
        typeof (e as { to?: unknown }).to === 'string' &&
        typeof (e as { type?: unknown }).type === 'string',
    )
  } catch {
    return []
  }
}

/** 组关系梳理输入材料：名册 + 角色卡摘要 + 已写正文节选（防超长，正文截断）。 */
function buildMineContext(bookRoot: string): string {
  const parts: string[] = []
  // 名册
  const rosterPath = join(bookRoot, '设定', '名册.md')
  if (existsSync(rosterPath)) {
    const t = readFileSync(rosterPath, 'utf8').trim()
    if (t) parts.push(`## 角色名册\n${t}`)
  }
  // 角色卡摘要（姓名/身份/目标/关系 + 正文前 300 字）
  const chars = readCharacterCards(join(bookRoot, '设定', '角色'), bookRoot)
  if (chars.length) {
    parts.push(
      '## 角色卡',
      chars
        .map((c) => {
          const meta = [c.身份, c.目标].filter(Boolean).join('/')
          const body = c.正文.replace(/\s+/g, ' ').slice(0, 300)
          return `### ${c.姓名}${meta ? `(${meta})` : ''}\n${body}${c.正文.length > 300 ? '…' : ''}`
        })
        .join('\n\n'),
    )
  }
  // 已写正文节选（正文目录，每章前 200 字，最多 8 章）
  const proseDir = join(bookRoot, '写作', '正文')
  if (existsSync(proseDir)) {
    const files = listMdRecursive(proseDir).slice(0, 8)
    if (files.length) {
      const excerpts = files.map((f) => {
        const rel = relative(bookRoot, f)
        const t = readFileSync(f, 'utf8').replace(/^---[\s\S]*?---/, '').replace(/\s+/g, ' ').trim().slice(0, 200)
        return `### ${rel}\n${t}`
      })
      parts.push('## 已写正文节选\n' + excerpts.join('\n\n'))
    }
  }
  return parts.join('\n\n')
}

/** 递归列出 md 文件（排序稳定）。 */
function listMdRecursive(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir, { recursive: true })) {
    if (typeof f !== 'string') continue
    if (!f.endsWith('.md') || f.startsWith('._')) continue
    const fp = join(dir, f)
    if (existsSync(fp)) out.push(fp)
  }
  out.sort()
  return out
}

/** 解析角色卡「关系」字段 → 关系边：「林远(师徒);赵衡(仇敌)」→ [{to:林远,type:师徒}]（#7.5） */
export function parseRelations(raw: string): { to: string; type: string }[] {
  if (!raw) return []
  const out: { to: string; type: string }[] = []
  for (const part of raw.split(/[;；,，]/)) {
    const seg = part.trim()
    if (!seg) continue
    // 新格式「对象=类型」(等号,无歧义) 优先；旧格式「对象(类型)」(括号,兼容历史数据)
    const m = seg.match(/^(.+?)=(.+)$/) ?? seg.match(/^(.+?)[(（](.+?)[)）]$/)
    if (m) out.push({ to: m[1]!.trim(), type: m[2]!.trim() })
  }
  return out
}

/** 关系类型规范表：关键词 → 标准短语（关系图标签用）。
 *  角色卡「关系」是自由文本，写法因书因人而异（师/师父/师徒/授业…）；
 *  此表把常见简写/同义词统一到完整短语，避免标签过简、换书也一致。
 *  按顺序匹配，先命中先用；都不中 → 保留原文（「暗棋」「血契」等自定义关系原样显示）。
 *  扩展：新别名补进对应类的正则即可。详见 Dev/Main/Plans/关系类型规范.md。 */
const RELATION_NORM: { label: string; test: RegExp }[] = [
  { label: '仇敌', test: /敌|仇|恨|怨/ },
  { label: '主仆', test: /主|仆|属|臣|奴|侍|麾下/ },
  { label: '师徒', test: /师|徒|弟子|传人|授业|同门/ },
  { label: '恋人', test: /恋|情人|爱人|红颜|相思/ },
  { label: '夫妻', test: /妻|夫|婚|配偶|嫁|娶|妾/ },
  { label: '手足', test: /兄|弟|姐|妹|同胞|手足/ },
  { label: '亲子', test: /父|母|爹|娘|双亲|亲子/ },
  { label: '挚友', test: /友|知交|故交|知己/ },
  { label: '同僚', test: /同僚|同袍|搭档|伙伴|战友|同窗/ },
]

/** 规范化关系类型（自由文本 → 标准短语）；无匹配则保留原文。 */
export function normalizeRelationType(raw: string): string {
  const t = raw.trim()
  for (const r of RELATION_NORM) if (r.test.test(t)) return r.label
  return t
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
