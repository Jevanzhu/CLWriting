/**
 * P0-1 短篇手测 —— 机器可验部分（新建短篇书全流程探活）。
 *
 * 真实 server + 真实建书（POST /api/books kind=short），验证「新建短篇书」路径：
 * 目录结构（无布线/无卷纲/设定层完整）/ 章纲范例 fm / 关系图放开 / 书架字数 / book.yaml。
 * AI 部分（onboard-ai / 写稿 / 三审）需真实 provider，留给人工手测。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let workDir = ''
let server: Awaited<ReturnType<typeof startServer>> | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-short-onboard-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const boot = (await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

const enc = encodeURIComponent

async function api(path: string, opts: RequestInit = {}): Promise<{ status: number; [k: string]: unknown }> {
  const headers = new Headers(opts.headers)
  if (opts.method && opts.method !== 'GET') headers.set('x-studio-token', token)
  const r = await fetch(`${baseUrl}${path}`, { ...opts, headers })
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>
  return { status: r.status, ...j }
}

const BOOK = '探活短篇集'

describe('P0-1 短篇手测·机器可验部分', () => {
  let bookRoot = ''

  it('1. 新建短篇书（kind=short）', async () => {
    const c = await api('/api/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: BOOK, genre: '悬疑', kind: 'short', host: 'cc' }),
    })
    expect(c.status).toBe(200)
    expect(c.kind).toBe('short')
  })

  it('2. 目录结构：无布线/无卷纲/无境界体系，有章纲/设定层/文风', () => {
    bookRoot = join(workDir, '短篇', BOOK)
    expect(existsSync(bookRoot)).toBe(true)
    // 短篇不建长程载重
    expect(existsSync(join(bookRoot, '布线'))).toBe(false)
    expect(existsSync(join(bookRoot, '大纲', '卷纲'))).toBe(false)
    expect(existsSync(join(bookRoot, '设定', '境界体系.md'))).toBe(false)
    // 与长篇同构可复用部分
    expect(existsSync(join(bookRoot, '大纲', '章纲', '0001-开篇.md'))).toBe(true)
    for (const d of ['角色', '物品', '伏笔']) expect(existsSync(join(bookRoot, '设定', d))).toBe(true)
    expect(existsSync(join(bookRoot, '设定', '世界观.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '设定', '名册.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '文风铁律.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '文风', '条目'))).toBe(true)
    expect(existsSync(join(bookRoot, '工作区'))).toBe(true)
    expect(existsSync(join(bookRoot, '写作', '正文'))).toBe(true)
  })

  it('3. 章纲范例 fm（F9 P1）：结构化 ChapterMeta + 清单三段式骨架', () => {
    const outline = readFileSync(join(bookRoot, '大纲', '章纲', '0001-开篇.md'), 'utf-8')
    expect(outline).toMatch(/章号: 1/)
    expect(outline).toMatch(/标题: 开篇/)
    expect(outline).toMatch(/钩子类型: 悬念钩/)
    expect(outline).toMatch(/钩子强弱: 中/)
    expect(outline).toMatch(/情绪定位: 铺垫/)
    expect(outline).toMatch(/场景: 叙事铺陈/)
    expect(outline).toMatch(/字数目标: \d+/)
    expect(outline).toMatch(/目标情绪: （待填）/)
    expect(outline).toMatch(/核心反转: （待填）/)
    expect(outline).toMatch(/反转线索表/)
    expect(outline).toMatch(/情绪曲线/)
    expect(outline).toMatch(/伏笔回收/)
    // 字数目标 = 悬疑反转 profile 推荐（word_min=6000），非长篇默认 3000
    expect(outline.match(/字数目标: (\d+)/)?.[1]).toBe('6000')
  })

  it('4. 书架卡（F3）：短篇显示字数（非 —）', async () => {
    const s = await api('/api/books')
    const books = s.books as { name: string; words: number; chapters: number }[]
    const mine = books.find((b) => b.name === BOOK)
    expect(mine).toBeTruthy()
    expect(typeof mine!.words).toBe('number')
    expect(typeof mine!.chapters).toBe('number')
  })

  it('5. 关系图（F1 放开）：settings 200 + 空结构不崩', async () => {
    const s = await api(`/api/books/${enc(BOOK)}/settings`)
    expect(s.status).toBe(200)
    expect(Array.isArray(s.characters)).toBe(true)
    const cfg = await api(`/api/books/${enc(BOOK)}/config`)
    expect((cfg.config as { kind: string }).kind).toBe('short')
  })

  it('6. 编辑器渲染（新书空态 overview 不崩）', async () => {
    const ov = await api(`/api/books/${enc(BOOK)}/overview`)
    expect(ov.status).toBe(200)
    expect(typeof (ov.progress as { chapters: number }).chapters).toBe('number')
  })

  it('7. book.yaml：short 精简配置（有 short 阈值、无 leads）', () => {
    const yaml = readFileSync(join(bookRoot, 'book.yaml'), 'utf-8')
    expect(yaml).toMatch(/kind: short/)
    expect(yaml).toMatch(/short:/)
    expect(yaml).toMatch(/word_min/)
    expect(yaml).not.toMatch(/leads:/)
  })

  it('8. 写一篇短篇正文 → 保存 → 机检全绿（手测步骤 3 + 6）', async () => {
    // AI 产出形态：完整 ChapterMeta fm（含钩子/情绪/目标情绪/核心反转）
    const body = [
      '---',
      '章号: 1',
      '标题: 雨夜门铃',
      '钩子类型: 悬念钩',
      '钩子强弱: 强',
      '情绪定位: 转折',
      '场景: 叙事铺陈',
      '目标情绪: 惊悚',
      '核心反转: 来客就是三年前死在七号公寓的人',
      '字数目标: 6000',
      '---',
      '',
      '雨夜，门铃响了。',
      '',
      '门外没有脚印，墙角的老式收音机却自己亮了起来。',
      '',
      '来客推门进来，浑身的雨水顺着衣摆滴在门槛上。灯下，我看清了他的脸——三年前，我亲手把他葬在七号公寓的花坛底下。',
      '',
      '他朝我笑，门铃又响了一声。',
      '',
    ].join('\n')
    // 新建文档（登记 manifest）→ 保存
    const d = await api(`/api/books/${enc(BOOK)}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relPath: '写作/正文/001-雨夜门铃.md', content: body }),
    })
    expect(d.status).toBe(201)
    const docId = (d as unknown as { docId: string }).docId
    expect(docId).toBeTruthy()
    // 再次保存（走乐观锁协议，验保存链路无报错）
    const s = await api(`/api/books/${enc(BOOK)}/documents/${docId}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: body, expectedRevision: (d as unknown as { revision: string }).revision, operationId: 'probe-op-1' }),
    })
    expect(s.status).toBe(200)
    // 机检：fm 合法（钩子/情绪枚举正确）→ 无红项
    const c = await api(`/api/books/${enc(BOOK)}/documents/${docId}/check`, { method: 'POST' })
    expect(c.status).toBe(200)
    expect(c.hasRed).toBe(false)
    // 短篇专属项（身体部位词/像/节数/开头零环境）在有无害短正文下应全绿
    const report = c.report as { sections: { name: string; items: { level: string }[] }[] }
    const reds = report.sections.flatMap((sn) => sn.items.filter((i) => i.level === 'red'))
    expect(reds).toHaveLength(0)
  })
})