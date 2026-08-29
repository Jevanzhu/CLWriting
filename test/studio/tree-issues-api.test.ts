/**
 * GET /api/books/:name/tree-issues 树红点聚合端点测（T9b）。
 * 验证两源聚合：机检 red（fm 章号不匹配）+ verdict 驳回；verdict 通过不计入。
 * rebuild 一次循环 checkWithDb 的正确性在此一并覆盖（runCheckForDocument 重构零回归）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
// R75-D-P3b（批 D）：/tree-issues 已有 5s TTL 结果缓存——本测验证「verdict 落盘后立即可见」，
// 注入 TTL=0 关缓存保住原即时语义（缓存三态由 r75-state-tree-issues-ttl.test.ts 覆盖）
import { __setTreeIssuesTtlForTest } from '../../src/studio/server/api/check.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { writeAnalysis } from '../../src/document/analysis.js'

const BOOK = '树红点测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let redDocId = '' // 0001：fm 章号 99 ≠ 文件名 0001 → 机检 red
let verdictDocId = '' // 0002：fm 干净，靠 verdict 驳回/通过切换
const prevDriver = process.env['CLWRITING_DRIVER']

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'GET',
        headers: { 'x-studio-token': token },
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
    req.end()
  })
}

beforeAll(async () => {
  __setTreeIssuesTtlForTest(0) // R75-D-P3b：关 TTL 缓存（it1→it2 verdict 翻转后需立即可见）
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-tree-issues-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  // leads.enabled: [] 关闭账本/成长线长程项，隔离出禁词 red 这一确定红源
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 树红点测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\nbudget:\n  calls_per_chapter: 8\n',
    'utf8',
  )
  // 文风铁律硬禁词「玉佩」→ 0001 正文命中即 red
  //（fm 章号 mismatch 走不通：fileName 从 chapter 派生，checkFrontMatter 永不触发）
  mkdirSync(join(bookRoot, '文风'), { recursive: true })
  writeFileSync(join(bookRoot, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf8')
  // 0001：正文含禁词「玉佩」→ checkBannedWords 报 banned-word（红）
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-红章.md'),
    '---\n章号: 1\n标题: 红章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，玉佩发光。\n',
    'utf8',
  )
  // 0002：fm 干净（章号 2 == 文件名 0002），无机检 red
  writeFileSync(
    join(bookRoot, '写作', '正文', '0002-净章.md'),
    '---\n章号: 2\n标题: 净章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n宗门震动，长老惊叹。\n',
    'utf8',
  )
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  redDocId = generateDocId()
  verdictDocId = generateDocId()
  // 0001/0002 登记定稿基线但内容已改（基线 ≠ 当前指纹）→ revision 态，聚合逻辑覆盖「定稿后改动」场景
  //（去 git 不再用 git init + staged 制造 dirty；基线存在也触发幂等闸跳过 migrateFinalizedRevisions）
  upsertEntry(m, { id: redDocId, nodeType: 'document', path: '写作/正文/0001-红章.md', parentId: null, finalizedRevision: 'sha256:baseline-v0', finalizedAt: '2026-07-25T00:00:00Z' })
  upsertEntry(m, { id: verdictDocId, nodeType: 'document', path: '写作/正文/0002-净章.md', parentId: null, finalizedRevision: 'sha256:baseline-v0', finalizedAt: '2026-07-25T00:00:00Z' })
  writeManifest(manifestPath, m)

  // tree-issues 后端跳过定稿态（final/published）；无 finalizedRevision → 树红点聚合仍机检
  //（去 git：不再用 git init + staged 制造 dirty；draft 态即被聚合覆盖）

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setTreeIssuesTtlForTest(null) // 恢复默认 TTL，避免污染同进程其它测试
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('GET /tree-issues 树红点聚合（T9b）', () => {
  it('机检 red + verdict 驳回 两源聚合到 issues', async () => {
    // 0002 落 verdict 驳回信封（作者裁决，model='author'）
    writeAnalysis(bookRoot, verdictDocId, 'review', {
      generatedAt: '2026-07-26T00:00:00Z',
      model: 'author',
      sourceHash: 'sha256:' + '0'.repeat(64),
      payload: { verdict: { approved: false, at: '2026-07-26T00:00:00Z' } },
    })

    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/tree-issues`)
    expect(r.status).toBe(200)
    const j = r.json as {
      ok: boolean
      issues: Record<string, { hasRed: boolean; verdictRejected: boolean }>
    }
    expect(j.ok).toBe(true)
    // 0001：fm 章 99 ≠ 文件名 0001 → hasRed=true
    expect(j.issues[redDocId]).toEqual(expect.objectContaining({ hasRed: true, verdictRejected: false }))
    // 0002：fm 干净 hasRed=false，verdict 驳回 verdictRejected=true
    expect(j.issues[verdictDocId]).toEqual(expect.objectContaining({ hasRed: false, verdictRejected: true }))
    expect(j.issues[verdictDocId]!.hasRed).toBe(false)
    expect(j.issues[verdictDocId]!.verdictRejected).toBe(true)
  })

  it('verdict 通过（approved）不计入 issues', async () => {
    // 0002 改 verdict 为通过
    writeAnalysis(bookRoot, verdictDocId, 'review', {
      generatedAt: '2026-07-26T00:00:00Z',
      model: 'author',
      sourceHash: 'sha256:' + '0'.repeat(64),
      payload: { verdict: { approved: true, at: '2026-07-26T00:00:00Z' } },
    })
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/tree-issues`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; issues: Record<string, unknown> }
    // 0002 fm 干净 + verdict 通过 → 不入 issues（仅 hasRed 或 verdictRejected 才入）
    expect(j.issues[verdictDocId]).toBeUndefined()
    // 0001 仍 fm red（不受 verdict 影响）
    expect(j.issues[redDocId]).toEqual(expect.objectContaining({ hasRed: true }))
  })
})

// ── T9b 修复回归：多章定稿 + 高章伏笔规划不应误报「凭空声称未来章」─────────
// 场景：全书已定稿 3 章，伏笔履历规划到第 3 章（证据均命中对应章正文）。
// 修复前：checkWithDb 用单章章号作 currentChapter → 检查 0001(章1) 时把第2/3章履历
// 判为「未来章」→ 树红点误报。修复后：currentChapter 用全书最高章号 3 → 不报。
const FUTURE_BOOK = '多章伏笔规划书'
let futureBookRoot = ''
let futureCh1DocId = ''

describe('T9b 修复：多章定稿 + 高章伏笔规划不误报 future', () => {
  beforeAll(async () => {
    // 复用同一 workDir（server 已按其启动），books.jsonl 追加第二本书
    const booksFile = join(workDir, '.clwriting', 'books.jsonl')
    writeFileSync(
      booksFile,
      JSON.stringify({ name: FUTURE_BOOK, path: FUTURE_BOOK, kind: 'long' }) + '\n',
      // 追加模式
      { flag: 'a' },
    )
    futureBookRoot = join(workDir, FUTURE_BOOK)
    mkdirSync(join(futureBookRoot, '写作', '正文'), { recursive: true })
    mkdirSync(join(futureBookRoot, '布线', '悬念'), { recursive: true })
    mkdirSync(join(futureBookRoot, '项目'), { recursive: true })
    writeFileSync(
      join(futureBookRoot, 'book.yaml'),
      'spec_version: 1\nkind: long\nbook:\n  title: 多章伏笔规划书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\nbudget:\n  calls_per_chapter: 8\n',
      'utf8',
    )
    // 三章定稿，证据词命中各自正文
    writeFileSync(
      join(futureBookRoot, '写作', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门。\n',
      'utf8',
    )
    writeFileSync(
      join(futureBookRoot, '写作', '正文', '0002-灵脉.md'),
      '---\n章号: 2\n标题: 灵脉\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n灵脉井古灵纹共鸣。\n',
      'utf8',
    )
    writeFileSync(
      join(futureBookRoot, '写作', '正文', '0003-旧约.md'),
      '---\n章号: 3\n标题: 旧约\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n旧籍封印松动迹象。\n',
      'utf8',
    )
    // 悬念伏笔：规划 1→2→3 章，证据均命中正文（v2 布线/悬念/）
    writeFileSync(
      join(futureBookRoot, '布线', '悬念', '悬念-001-灵脉之谜.md'),
      `---
编号: 悬念-001
标题: 灵脉之谜
类型: 悬念
状态: 进行中
开启章: 1
---

## 履历

- 第01章 设下：天脉异象惊动宗门
- 第02章 递进：灵脉井古灵纹共鸣
- 第03章 递进：旧籍封印松动迹象
`,
      'utf8',
    )
    const manifestPath = join(futureBookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    futureCh1DocId = generateDocId()
    // 三章登记定稿基线（语义 = 已定稿到第 3 章）→ maxWrittenChapterOf 基准 = 3
    const chPaths = ['写作/正文/0001-开篇.md', '写作/正文/0002-灵脉.md', '写作/正文/0003-旧约.md']
    for (const p of chPaths) {
      upsertEntry(m, {
        id: p === '写作/正文/0001-开篇.md' ? futureCh1DocId : generateDocId(),
        nodeType: 'document',
        path: p,
        parentId: null,
        finalizedRevision: computeRevision(join(futureBookRoot, p)),
        finalizedAt: new Date().toISOString(),
      })
    }
    writeManifest(manifestPath, m)
  })

  afterAll(async () => {
    if (futureBookRoot) rmSync(futureBookRoot, { recursive: true, force: true })
  })

  it('已定稿到第3章时，规划到第3章的伏笔不计入树红点', async () => {
    const r = await get(`/api/books/${encodeURIComponent(FUTURE_BOOK)}/tree-issues`)
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; issues: Record<string, unknown> }
    // 修复后：0001 章不再因履历第2/3章被误报 lead-chapter-future → 无红
    expect(j.issues[futureCh1DocId]).toBeUndefined()
  })

  it('单章 check 端点同样以全书最高章号为基准（不误报 future）', async () => {
    const u = new URL(baseUrl)
    const result = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: `/api/books/${encodeURIComponent(FUTURE_BOOK)}/documents/${encodeURIComponent(futureCh1DocId)}/check`,
          method: 'POST',
          headers: { 'x-studio-token': token },
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
      req.end()
    })
    expect(result.status).toBe(200)
    const j = result.json as { ok: boolean; hasRed: boolean; report: { sections: { items: { checkId: string }[] }[] } }
    expect(j.ok).toBe(true)
    expect(j.hasRed).toBe(false)
    const futureLeads = j.report.sections.flatMap((s) => s.items).filter((i) => i.checkId === 'lead-chapter-future')
    expect(futureLeads).toHaveLength(0)
  })
})
