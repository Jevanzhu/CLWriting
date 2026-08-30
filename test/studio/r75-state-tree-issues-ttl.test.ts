/**
 * R75-D-P3b（批 D）回归：/state 与 /tree-issues 的 5s TTL 结果缓存。
 *
 * 口径对齐 health.ts styleScanCache（书键 Map + FIFO + 纯 TTL；写路径不挂即时失效，
 * 盘上变更最迟 TTL 后自愈）。三态验证（TTL 注入 300ms 消除墙钟，先例 R62-21）：
 * - 首查：现算（结果反映盘上现状）；
 * - 二查（TTL 内）：命中缓存——盘上变更不可见；
 * - 写后 + TTL 到期：重算——盘上变更可见。
 * 另验证删书生命周期清理（R67-15 forgetBookKeyedCaches 家族接线）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import {
  __setStateTtlForTest,
  __stateCacheHasForTest,
} from '../../src/studio/server/api/state.js'
import {
  __setTreeIssuesTtlForTest,
  __treeIssuesCacheHasForTest,
} from '../../src/studio/server/api/check.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const STATE_BOOK = 'R75判态缓存书' // 短篇无布线 → 态 7，nextChapter 随正文章数变化
const TREE_BOOK = 'R75树红点缓存书' // 文风硬禁词红章 → issues 随正文改写变化
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let treeBookRoot = ''
let redDocId = ''
let stateManifestPath = ''

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: any = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

const CH_FM = (n: number, t: string) => `---\n章号: ${n}\n标题: ${t}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n`

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r75-ttl-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: STATE_BOOK, path: STATE_BOOK, kind: 'short' }) + '\n' +
      JSON.stringify({ name: TREE_BOOK, path: TREE_BOOK, kind: 'long' }) + '\n',
  )
  // 判态书：短篇无布线 → 态 7；1 章已定稿（清单 finalizedRevision）→ nextChapter=2。
  // （短篇口径：未定稿篇计入 excludeNames 不推 nextChapter——0001 不登记定稿则
  //   nextChapter 恒指回 1，三态无从观测；定稿登记是本测前提）
  const stateRoot = join(workDir, STATE_BOOK)
  mkdirSync(join(stateRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(stateRoot, '项目'), { recursive: true })
  writeFileSync(join(stateRoot, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: R75判态缓存书\n  genre: 玄幻\nhost: cc\n')
  writeFileSync(join(stateRoot, '写作', '正文', '0001-开篇.md'), CH_FM(1, '开篇') + '主角登场。\n')
  stateManifestPath = join(stateRoot, '项目', '文档清单.jsonl')
  const sm = readManifest(stateManifestPath)
  upsertEntry(sm, { id: generateDocId(), nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null, finalizedRevision: 'sha256:' + 'a'.repeat(64), finalizedAt: '2026-08-29T00:00:00.000Z' })
  writeManifest(stateManifestPath, sm)

  // 树红点书：文风硬禁词「玉佩」→ 0001 命中即 red（造法同 tree-issues-api.test.ts）
  treeBookRoot = join(workDir, TREE_BOOK)
  mkdirSync(join(treeBookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(treeBookRoot, '项目'), { recursive: true })
  mkdirSync(join(treeBookRoot, '文风'), { recursive: true })
  writeFileSync(join(treeBookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: R75树红点缓存书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n')
  writeFileSync(join(treeBookRoot, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n')
  // R29-1（二十九轮）禁词新口径（前后非汉字边界）夹具适配：玉佩后邻汉字「发」被边界
  // 拦截不再报红——改夹持形态（两侧标点 = 非汉字边界）恢复命中（造法同 tree-issues-api.test.ts）
  writeFileSync(join(treeBookRoot, '写作', '正文', '0001-红章.md'), CH_FM(1, '红章') + '主角登场，玉佩，通体发亮。\n')
  const manifestPath = join(treeBookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  redDocId = generateDocId()
  upsertEntry(m, { id: redDocId, nodeType: 'document', path: '写作/正文/0001-红章.md', parentId: null })
  writeManifest(manifestPath, m)

  // R75-D-P3b：TTL 注入短档——三态用例免真实 5s 墙钟（先例 R62-21）。
  // R76-37（二十四轮 F 域）：300ms→1000ms——「窗内二查」用例在首查与二查之间夹着
  // writeFileSync+清单读写，慢机/CI 卡顿下这段 I/O 超 300ms 即缓存已过期、二查变重算，
  // 假红（fail-noisy 方向无豁免）；1000ms 给足 3 倍裕量，到期侧睡 TTL+500 不受影响
  //（墙钟到期与机器快慢无关）。
  __setStateTtlForTest(1000)
  __setTreeIssuesTtlForTest(1000)
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setStateTtlForTest(null) // 恢复默认 TTL，避免污染同进程其它测试
  __setTreeIssuesTtlForTest(null)
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R75-D-P3b：GET /state 5s TTL 缓存三态', () => {
  it('首查现算 → TTL 内二查命中（盘上新增章不可见）→ TTL 到期重算可见', async () => {
    // 首查：1 章 → nextChapter=2（现算反映盘上现状）
    const first = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(first.status).toBe(200)
    expect(first.json.nextChapter).toBe(2)

    // 盘上变更：新增第 2 章并登记定稿（短篇未定稿篇不推 nextChapter，须同时落清单）
    writeFileSync(join(workDir, STATE_BOOK, '写作', '正文', '0002-次章.md'), CH_FM(2, '次章') + '第二章登场。\n')
    const sm2 = readManifest(stateManifestPath)
    upsertEntry(sm2, { id: generateDocId(), nodeType: 'document', path: '写作/正文/0002-次章.md', parentId: null, finalizedRevision: 'sha256:' + 'b'.repeat(64), finalizedAt: '2026-08-29T00:00:00.000Z' })
    writeManifest(stateManifestPath, sm2)

    // TTL 内二查：命中缓存——nextChapter 仍为 2（未见新章）
    const second = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(second.status).toBe(200)
    expect(second.json.nextChapter).toBe(2)

    // TTL（1000ms，R76-37）到期 → 重算见到新章
    await new Promise((r) => setTimeout(r, 1000 + 500))
    const third = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(third.status).toBe(200)
    expect(third.json.nextChapter).toBe(3)
  })
})

describe('R75-D-P3b：GET /tree-issues 5s TTL 缓存三态', () => {
  it('首查现算 → TTL 内二查命中（改正文不可见）→ TTL 到期重算可见', async () => {
    // 首查：禁词「玉佩」命中 → issues 含该章 hasRed
    const first = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    expect(first.status).toBe(200)
    expect(first.json.issues[redDocId]).toEqual(expect.objectContaining({ hasRed: true }))

    // 盘上变更：正文洗净禁词（重算应无红 → issues 空）
    writeFileSync(join(treeBookRoot, '写作', '正文', '0001-红章.md'), CH_FM(1, '红章') + '主角登场，霞光流转。\n')

    // TTL 内二查：命中缓存——红点仍在
    const second = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    expect(second.status).toBe(200)
    expect(second.json.issues[redDocId]).toEqual(expect.objectContaining({ hasRed: true }))

    // TTL 到期 → 重算见到洗净后的正文（无红不入 issues）
    await new Promise((r) => setTimeout(r, 1000 + 500))
    const third = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    expect(third.status).toBe(200)
    expect(third.json.issues[redDocId]).toBeUndefined()
  })
})

describe('R75-D-P3b：删书生命周期清理（forgetBookKeyedCaches 接线）', () => {
  it('GET 填充两缓存 → DELETE /api/books/:name 后条目随书失效', async () => {
    // 填充：两个端点各命中一次（上两组用例后 TTL 已过期，本次为重算落缓存）
    await new Promise((r) => setTimeout(r, 1000 + 500))
    const s = await get(`/api/books/${encodeURIComponent(STATE_BOOK)}/state`)
    expect(s.status).toBe(200)
    const t = await get(`/api/books/${encodeURIComponent(TREE_BOOK)}/tree-issues`)
    expect(t.status).toBe(200)
    expect(__stateCacheHasForTest(join(workDir, STATE_BOOK))).toBe(true) // 端点填充
    expect(__treeIssuesCacheHasForTest(treeBookRoot)).toBe(true)

    const del = await req('DELETE', `/api/books/${encodeURIComponent(STATE_BOOK)}`)
    expect(del.status).toBe(200)
    expect(__stateCacheHasForTest(join(workDir, STATE_BOOK))).toBe(false) // 删书清理
    // 另一本书的 tree-issues 条目不受影响（书键隔离）
    expect(__treeIssuesCacheHasForTest(treeBookRoot)).toBe(true)
    const del2 = await req('DELETE', `/api/books/${encodeURIComponent(TREE_BOOK)}`)
    expect(del2.status).toBe(200)
    expect(__treeIssuesCacheHasForTest(treeBookRoot)).toBe(false)
  })
})
