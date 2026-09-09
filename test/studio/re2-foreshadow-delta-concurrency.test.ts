/**
 * 重评2-P3-①（2026-09-09 全量重评 GLM-5.3）回归：伏笔差分事件并发保存不重复计窗。
 *
 * 原 documents.ts PUT content 的 foreshadowSnapshot 读在保存串行队列之外：两并发
 * 保存交叠时双方基线同取前者变更前的状态，而 recordForeshadowDelta 的差分读「当刻」
 * 全量状态——后落库的一方把先落库者的变更一并计入自己的差分窗（事件流重复计窗）。
 * 修复后「快照读 → save → 差分落事件」整段入 per-book 串行链，两并发保存的事件
 * 各归各窗（总数 2，无重复）。
 *
 * 确定性手法：vi.mock 把 openSessionStoreAsync 首次调用延迟 75ms——先完成 save 的
 * 请求被 park 在「已落盘、差分未落库」窗口，另一请求必然在此窗口内做快照读（修复前
 * 形态即重复计窗；修复后另一请求整段入链等待，其基线已含前者变更）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'
import { computeRevision } from '../../src/document/revision.js'

vi.mock('../../src/events/store.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/events/store.js')>()
  let gated = false
  return {
    ...mod,
    openSessionStoreAsync: async (...args: Parameters<typeof mod.openSessionStoreAsync>) => {
      if (!gated) {
        gated = true
        await new Promise((r) => setTimeout(r, 75))
      }
      return mod.openSessionStoreAsync(...args)
    },
  }
})

const BOOK = '伏笔并发书'
let workDir = ''
let userDataPath = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

/** 文件已存在时的 expectedRevision（sha256(现有内容)）。 */
function revOf(relPath: string): `sha256:${string}` {
  return computeRevision(join(workDir, BOOK, relPath))
}

function putContent(
  docId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/content`,
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: baseUrl, 'x-studio-token': token },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 留 null */
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

/** 读 workspace 会话里的 foreshadow/change 事件（按落库序）。 */
function foreshadowEvents(): { operation: string; title: string }[] {
  const store = openSessionStore(userDataPath, join(workDir, BOOK))!
  try {
    const sid = store.workspaceSession(bookHash(join(workDir, BOOK)))
    return store
      .listEvents(bookHash(join(workDir, BOOK)), sid)
      .filter((e) => e.type === 'foreshadow/change')
      .map((e) => ({ operation: String(e.data['operation']), title: String(e.data['title']) }))
  } finally {
    store.close()
  }
}

/** 伏笔条目 md（fm 状态可变）。 */
function fsBody(title: string, status: string, word: string): string {
  return `---\n标题: ${title}\n状态: ${status}\n重要性: 高\n关联词: ${title}\n---\n\n${word}\n`
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-fs-cc-'))
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-fs-cc-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 伏笔并发书\n  genre: 玄幻\nhost: cc\n',
  )
  // 清单登记两条伏笔（各自独立变更，互不为同一文件的先后版本）
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_fs1","nodeType":"document","path":"设定/伏笔/古剑.md","parentId":null}',
      '{"id":"doc_fs2","nodeType":"document","path":"设定/伏笔/玉佩.md","parentId":null}',
    ].join('\n') + '\n',
  )
  mkdirSync(join(bookRoot, '设定', '伏笔'), { recursive: true })
  writeFileSync(join(bookRoot, '设定', '伏笔', '古剑.md'), fsBody('古剑', '未回收', '主角佩剑藏机关。'), 'utf-8')
  writeFileSync(join(bookRoot, '设定', '伏笔', '玉佩.md'), fsBody('玉佩', '未回收', '身世信物。'), 'utf-8')

  server = await startServerSafe({ port: 0, workDir, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('重评2-P3-①：伏笔差分事件并发保存不重复计窗', () => {
  it('两并发伏笔保存交叠（前者差分被 park 在落库窗内）→ 事件各归各窗，不重复', async () => {
    // 两请求同时发出：各自「未回收 → 已回收」，独立条目各应恰好落 1 条 complete 事件。
    // 修复前后差异：后落库 delta 的基线是否被 park 的前者拉回到变更前状态。
    const [ra, rb] = await Promise.all([
      putContent('doc_fs1', {
        content: fsBody('古剑', '已回收', '机关已开。'),
        expectedRevision: revOf('设定/伏笔/古剑.md'),
        operationId: 'op-cc-fs1',
        origin: 'manual',
      }),
      putContent('doc_fs2', {
        content: fsBody('玉佩', '已回收', '信物已认。'),
        expectedRevision: revOf('设定/伏笔/玉佩.md'),
        operationId: 'op-cc-fs2',
        origin: 'manual',
      }),
    ])
    expect(ra.status).toBe(200)
    expect(rb.status).toBe(200)
    // 恰好 2 条事件（古剑/玉佩 各 1 次 complete）——重复计窗形态下玉佩或古剑会出现 2 次
    const events = foreshadowEvents()
    expect(events).toHaveLength(2)
    const sorted = events.slice().sort((a, b) => a.title.localeCompare(b.title))
    expect(sorted).toEqual([
      { operation: 'complete', title: '古剑' },
      { operation: 'complete', title: '玉佩' },
    ])
  })
})
