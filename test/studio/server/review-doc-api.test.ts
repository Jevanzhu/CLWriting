/**
 * POST /api/books/:name/documents/:docId/review 三审直读端点集成测（M12 块1 B0.2）。
 * mock driver 下验证全链路：机检 → buildReviewPacket → generateTool(submit_issues)×3 → collectReviewIssues → 落信封。
 * mock submit_issues 返合法 issues JSON → 断言 collected.ok（W-P1-1 回归：预算降级合审档
 * 必须写 issues-combined.json，collect 才收得到，否则作者把预算调成 1-2 时三审必「不成立」）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'
import { readManifest, writeManifest, upsertEntry } from '../../../src/document/manifest.js'
import { generateDocId } from '../../../src/document/stable-id.js'
import { openSessionStore, bookHash } from '../../../src/events/store.js'

const BOOK = '三审测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let chapterDocId = ''
let userDataDir = ''
const prevDriver = process.env['CLWRITING_DRIVER']

function post(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-review-doc-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '大纲', '悬念'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 三审测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\nbudget:\n  calls_per_chapter: 6\n' /* 6≠旧默认 8：启动迁移不删此行（下个用例的文本替换基准须存活） */,
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，玉佩发光，宗门震动。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  chapterDocId = generateDocId()
  upsertEntry(m, { id: chapterDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  // 2026-08-19 全局固定决策：calls_per_chapter 书级值被忽略（applyGlobalDefaults 一律
  // global→fallback 覆盖）——预算用例改经 global.json 驱动，server 须传 userDataPath
  userDataDir = mkdtempSync(join(tmpdir(), 'clwriting-review-doc-ud-'))
  writeFileSync(join(userDataDir, 'global.json'), '{}', 'utf8')
  server = await startServerSafe({ port: 0, workDir, userDataPath: userDataDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('POST /documents/:docId/review 三审直读（M12 B0.2）', () => {
  it('正文文档 → 200 + lenses + collected.ok + 信封落盘（kind=review）', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      lenses: string[]
      collected: { ok: boolean; chapter: number; tier: string; lenses_run: string[]; missing_lenses: string[] }
    }
    expect(j.ok).toBe(true)
    expect(j.lenses.length).toBeGreaterThan(0)
    // mock submit_issues 返合法 issues → 独立档逐文件可回收，审稿单成立
    expect(j.collected.ok).toBe(true)
    expect(j.collected.missing_lenses).toEqual([])
    expect(j.collected.chapter).toBe(1)
    expect(j.collected.tier).not.toBe('combined')

    // 信封落盘：项目/分析/<docId>.json 含 review kind
    const envPath = join(bookRoot, '项目', '分析', `${chapterDocId}.json`)
    expect(existsSync(envPath)).toBe(true)
    const env = JSON.parse(readFileSync(envPath, 'utf-8')) as {
      review: { sourceHash: string; payload: { collected: unknown; incomplete?: boolean } }
    }
    expect(env.review).toBeTypeOf('object')
    // R63-4：采集成立（ok:true）→ 信封无 incomplete 标记（ok:false 时打标——单测见
    // test/review/run.test.ts R63-4 两例，端点写点是一行条件展开）
    expect(env.review.payload.incomplete).toBeUndefined()
    expect(typeof env.review.sourceHash).toBe('string')
    expect(env.review.payload.collected).not.toBeUndefined()
  })

  it('预算 1 → 降级合审档 → issues-combined.json 契约 + collected.ok（W-P1-1 回归）', async () => {
    // 长篇无布线 = 2 视角；预算 1 < 2 → selectReviewTier 降 combined（单文件单调用）。
    // 2026-08-19 起单章上限「全局固定」（书级值被 applyGlobalDefaults 忽略）——预算
    // 只能经 global.json 的 callsPerChapter 下调，书 yaml 直写不再生效
    const globalJson = join(userDataDir, 'global.json')
    writeFileSync(globalJson, JSON.stringify({ callsPerChapter: 1 }), 'utf8')
    try {
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
      expect(r.status).toBe(200)
      const j = r.json as {
        ok: boolean
        lenses: string[]
        collected: {
          ok: boolean
          tier: string
          lenses_run: string[]
          collected_lenses: string[]
          missing_lenses: string[]
        }
      }
      expect(j.ok).toBe(true)
      expect(j.collected.tier).toBe('combined')
      // 合审单文件视为全视角覆盖：无缺失、审稿单成立（修复前写 issues-<锚视角>.json → 全缺失 + ok:false）
      expect(j.collected.ok).toBe(true)
      expect(j.collected.missing_lenses).toEqual([])
      expect(j.collected.collected_lenses.sort()).toEqual([...j.collected.lenses_run].sort())
      // 合审 = 单次调用，HTTP lenses 只含锚视角
      expect(j.lenses.length).toBe(1)
    } finally {
      writeFileSync(globalJson, '{}', 'utf8')
    }
  })

  it('未登记 docId → 404 NOT_FOUND', async () => {
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/doc_${'0'.repeat(26)}/review`, {})
    expect(r.status).toBe(404)
    const j = r.json as { ok: boolean; code: string }
    expect(j.code).toBe('NOT_FOUND')
  })
})

// 开关 auto.knowledge_injection：三审侧「视角技法注入」的关停面。
// 判据取 llm/call 的 promptMeta.files（铁律①登记通道）——只断「接口仍 200」不足以
// 证明注入被摘：技法段拼在 system 里，不进 files 清单就无从分辨。故按「知识层」前缀
// 断两头：缺省必在（正向锚）、显式 false 必不在（关停锚），撤任一端本组即红。
// 前缀取宽（`知识层/` 与 `知识层(内置)/` 两形态都算）——启动迁移会给书根播种
// 知识层/，命中书级时登记名是该形态；随包兜底才是「知识层(内置)/」。
describe('auto.knowledge_injection：三审视角技法注入开关', () => {
  // bookRoot 在模块级 beforeAll 才赋值，路径须在钩子/用例内取（describe 体求值时它是空串）。
  // 空 bookRoot 必须硬拦：join('', 'book.yaml') === 'book.yaml' 会落到**仓库根**——
  // 模块级 beforeAll 若先失败，本组 afterAll 的写回就会在仓根留下一个空 book.yaml
  // （`git status` 里凭空多一件未跟踪文件，且看起来像作者的书配置）。
  const yamlPath = (): string => {
    if (!bookRoot) throw new Error('bookRoot 未就绪（模块级 beforeAll 未跑完）——拒写仓根 book.yaml')
    return join(bookRoot, 'book.yaml')
  }
  const KNOWLEDGE_PREFIX = '知识层'
  let baseYaml = ''

  beforeAll(() => {
    baseYaml = readFileSync(yamlPath(), 'utf-8')
  })
  afterAll(() => {
    if (!baseYaml) return // 基线没读到 → 无可恢复内容，宁可不写也不造空文件
    writeFileSync(yamlPath(), baseYaml, 'utf8')
  })

  /** 本次三审各 llm/call 的 promptMeta.files 并集（本档内多轮三审共用同一事件库，
   *  按 startSeq 只取本用例新增的事件——否则前序用例的注入源会串进来）。
   *  读毕即 close（引用归零释放句柄）——否则 win 上 userDataDir 被占，
   *  afterAll 的 rmSync 报 EPERM（同族见 events/store.test.ts 的句柄竞态收口）。 */
  function reviewCallFiles(startSeq: number): string[] {
    const store = openSessionStore(userDataDir, bookRoot)
    expect(store).not.toBeNull()
    try {
      const evs = store!.listEvents(bookHash(bookRoot))
      const out: string[] = []
      for (const e of evs) {
        if (e.seq < startSeq || e.type !== 'llm/call') continue
        const files = (e.data as { promptMeta?: { files?: string[] } }).promptMeta?.files ?? []
        out.push(...files)
      }
      return out
    } finally {
      store!.close()
    }
  }

  /** 当前事件库尾序号（下一次三审的新事件自 seq > 此值起） */
  function lastSeq(): number {
    const store = openSessionStore(userDataDir, bookRoot)
    try {
      const evs = store!.listEvents(bookHash(bookRoot))
      return evs.length === 0 ? 0 : evs[evs.length - 1]!.seq
    } finally {
      store!.close()
    }
  }

  it('缺省（键未设）→ 技法注入源进 promptMeta.files', async () => {
    const from = lastSeq()
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
    expect(r.status).toBe(200)
    const files = reviewCallFiles(from)
    expect(files.length).toBeGreaterThan(0) // 本用例确有三审调用发生（否则下条断言恒真）
    expect(files.some((f) => f.startsWith(KNOWLEDGE_PREFIX))).toBe(true)
  })

  it('显式 false → 三审照常成立，但技法注入源不再登记', async () => {
    writeFileSync(yamlPath(), `${baseYaml}auto:\n  knowledge_injection: false\n`, 'utf8')
    try {
      const from = lastSeq()
      const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${chapterDocId}/review`, {})
      expect(r.status).toBe(200)
      const j = r.json as { ok: boolean; collected: { ok: boolean } }
      expect(j.ok).toBe(true)
      expect(j.collected.ok).toBe(true) // 关的是技法注入，不是三审本身
      const files = reviewCallFiles(from)
      expect(files.length).toBeGreaterThan(0)
      expect(files.filter((f) => f.startsWith(KNOWLEDGE_PREFIX))).toEqual([])
    } finally {
      writeFileSync(yamlPath(), baseYaml, 'utf8')
    }
  })
})

describe('R64-10（十二轮）：读稿守卫——existsSync 后读不到正文给 IO 人话信封', () => {
  it('清单路径指向目录（existsSync 真、readFileSync 抛 EISDIR）→ 500 IO 不裸穿', async () => {
    // 用迁移后仍存在的目录作靶（boot 的 migrateFinalizedRevisions 会把非 git 书
    // 定稿/正文 的未跟踪稿迁去 写作/正文 并清空 定稿——不能拿它当靶子）
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    const dirDocId = generateDocId()
    upsertEntry(m, { id: dirDocId, nodeType: 'document', path: '写作/正文', parentId: null }) // 目录：存在但读不了
    writeManifest(manifestPath, m)
    const r = await post(`/api/books/${encodeURIComponent(BOOK)}/documents/${dirDocId}/review`, {})
    expect(r.status).toBe(500)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('IO_ERROR')
    expect(j.error).toContain('读不到正文')
  })
})
